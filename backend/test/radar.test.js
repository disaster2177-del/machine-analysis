import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { RADAR_DDL, RADAR_FIELDS } from '../src/radar/fields.js';
import { matchRadarAnalysis } from '../src/radar/analytics.js';
import { parseQuestion } from '../src/nlq/ruleParser.js';

// Two sensors (4 s and 10 s scans) tracking two aircraft for 10 minutes; sensor Bravo misses every 5th scan.
const SEED = `
INSERT INTO radar_plots (ts, received_at, sac, sic, sensor_id, report_type, range_nm, azimuth_deg, mode3a, mode3a_valid, mode3a_garbled,
  flight_level, fl_valid, aircraft_address, callsign, track_number, x_nm, y_nm, ground_speed_kt, heading_deg, track_status, climb_mode, track_end, ghost, lat, lon)
SELECT TIMESTAMP '2026-09-30 10:00:00' + to_milliseconds(CAST(k * period * 1000 AS BIGINT)) AS ts,
  TIMESTAMP '2026-09-30 10:00:00' + to_milliseconds(CAST(k * period * 1000 + 500 AS BIGINT)),
  25, sic, sensor, 'MODES_ROLLCALL', 50 + k * 0.1, 45, CASE WHEN ac = 1 AND k > 100 THEN '7700' ELSE '1234' END, true, false,
  CASE WHEN k = 50 THEN 350 ELSE 300 END, true, CASE ac WHEN 1 THEN 'ABC123' ELSE 'DEF456' END, 'TST' || ac, ac, 35 + k * 0.07, 35 + k * 0.07,
  450, 45, 'CONFIRMED', 'MAINTAINING', false, false, 19 + k * 0.001 + sic * 0.0001, 73 + k * 0.001
FROM (VALUES (1, 'Alpha', 4.0), (2, 'Bravo', 10.0)) s(sic, sensor, period), range(1, 3) a(ac), range(0, 150) r(k)
WHERE k * period <= 600 AND NOT (sensor = 'Bravo' AND k % 5 = 0);`;

const db = await DuckDBInstance.create(':memory:');
const con = await db.connect();
await con.run(RADAR_DDL);
await con.run(SEED);

const kind = (t) => (t === 'TIMESTAMP' ? 'time' : /INT|DOUBLE/.test(t) ? 'numeric' : t === 'VARCHAR' ? 'text' : 'boolean');
const columns = RADAR_FIELDS.map((f) => ({ name: f.name, type: f.type, kind: kind(f.type), aliases: f.aliases }));
for (const c of columns) if (c.name === 'sensor_id') Object.assign(c, { kind: 'category', values: ['Alpha', 'Bravo'] });
const schema = {
  table: 'radar_plots', radar: true, columns, timeColumn: 'ts', latColumn: 'lat', lonColumn: 'lon',
  timeRange: { min: '2026-09-30 10:00:00', max: '2026-09-30 10:10:00' },
};

async function run(question) {
  const plan = parseQuestion(question, schema, {});
  const a = matchRadarAnalysis(question, schema, plan);
  assert.ok(a && !a.error, `no analysis for "${question}": ${a?.error}`);
  const rows = (await con.runAndReadAll(a.sql)).getRowObjectsJson();
  return { a, rows: a.postprocess ? a.postprocess(rows) : rows };
}

const cases = {
  'probability of detection by sensor': 'pd',
  'scan period of each radar': 'scan',
  'data gaps longer than 60 seconds': 'gaps',
  'sensor status': 'status',
  'registration bias between sensors': 'bias',
  'any emergency squawks?': 'emergency',
  'which aircraft changed their squawk code': 'codechange',
  'altitude jumps': 'altjump',
  'coverage of radar Alpha': 'coverage',
  'track statistics per sensor': 'tracks',
  'latency by sensor': 'latency',
  'clutter and false plots': 'clutter',
};

for (const [q, id] of Object.entries(cases)) {
  test(`"${q}" -> ${id} and runs`, async () => {
    const { a } = await run(q);
    assert.equal(a.id, id);
  });
}

test('general questions are not hijacked by radar analyses', () => {
  for (const q of ['show latest plots for callsign TST1', 'how many plots per sensor', 'average range by sensor']) {
    assert.equal(matchRadarAnalysis(q, schema, parseQuestion(q, schema, {})), null, q);
  }
});

test('scan period and Pd values are right', async () => {
  const scan = (await run('scan period of each radar')).rows;
  assert.deepEqual(scan.map((r) => [r.sensor_id, r.scan_period_s]), [['Alpha', 4], ['Bravo', 10]]);
  const pd = Object.fromEntries((await run('probability of detection')).rows.map((r) => [r.sensor_id, r.pd_percent]));
  assert.equal(pd.Alpha, 100);
  assert.ok(pd.Bravo > 75 && pd.Bravo < 85, `Bravo Pd ${pd.Bravo}`);
});

test('emergency, code change, altitude jump detected', async () => {
  assert.equal((await run('any emergency squawks')).rows[0].squawk, '7700');
  assert.ok((await run('squawk changes')).rows.some((r) => r.old_code === '1234' && r.new_code === '7700'));
  assert.ok((await run('altitude jumps')).rows.some((r) => r.flight_level === 350));
});

test('filters from the question apply (sensor + explicit time)', async () => {
  const { a, rows } = await run('scan period for sensor Bravo between 2026-09-30 and 2026-09-30');
  assert.match(a.sql, /"sensor_id" = 'Bravo'/);
  assert.deepEqual(rows.map((r) => r.sensor_id), ['Bravo']);
});

test('squawk alias filters on mode3a', () => {
  const plan = parseQuestion('how many plots with squawk 1234', schema, {});
  assert.match(plan.sql, /"mode3a" ILIKE '1234'/);
});
