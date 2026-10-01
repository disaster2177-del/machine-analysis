// Generate a realistic synthetic dataset for testing.
//   node scripts/generate-sample-data.js                 -> 5 crore (50,000,000) rows
//   node scripts/generate-sample-data.js --rows 1000000  -> 10 lakh rows
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const rows = Number(argValue('--rows', 50_000_000));
const out = path.resolve(argValue('--out', config.dbPath));
const table = argValue('--table', config.table);
const start = argValue('--start', '2025-01-01 00:00:00');
const days = Number(argValue('--days', 365));

fs.mkdirSync(path.dirname(out), { recursive: true });
for (const f of [out, `${out}.wal`, `${out}.meta.json`]) fs.rmSync(f, { force: true });

console.log(`Generating ${rows.toLocaleString('en-IN')} rows into ${out} (table "${table}") ...`);
const t0 = Date.now();
const db = await DuckDBInstance.create(out);
const con = await db.connect();

await con.run(`
CREATE TABLE sites AS SELECT * FROM (VALUES
  (0, 'Pune', 18.5204, 73.8567), (1, 'Mumbai', 19.0760, 72.8777), (2, 'Chennai', 13.0827, 80.2707),
  (3, 'Bengaluru', 12.9716, 77.5946), (4, 'Delhi', 28.6139, 77.2090), (5, 'Hyderabad', 17.3850, 78.4867),
  (6, 'Kolkata', 22.5726, 88.3639), (7, 'Ahmedabad', 23.0225, 72.5714)
) AS t(site_id, site, lat, lon);

CREATE TABLE sensors AS SELECT * FROM (VALUES
  (0, 'temperature', 'C', 45.0, 12.0), (1, 'pressure', 'bar', 6.0, 1.5), (2, 'vibration', 'mm/s', 4.0, 2.0),
  (3, 'humidity', '%', 55.0, 15.0), (4, 'voltage', 'V', 230.0, 8.0), (5, 'current', 'A', 15.0, 4.0)
) AS t(sensor_id, sensor_type, unit, base, amp);
`);

const span = BigInt(days) * 86_400_000_000n;
await con.run(`
CREATE TABLE ${table} AS
WITH base AS (
  SELECT
    i,
    TIMESTAMP '${start}' + to_microseconds(CAST(i::HUGEINT * ${span} // ${rows} AS BIGINT)) AS ts,
    i % 400 AS machine_no,
    (hash(i * 31 + 7) % 1000000) / 1000000.0 AS r1,
    (hash(i * 17 + 3) % 1000000) / 1000000.0 AS r2,
    (hash(i * 13 + 5) % 1000000) / 1000000.0 AS r3,
    (hash(i * 11 + 9) % 1000000) / 1000000.0 AS r4
  FROM range(${rows}) t(i)
), enriched AS (
  SELECT b.*, s.site, s.lat AS site_lat, s.lon AS site_lon, se.sensor_type, se.unit, se.base, se.amp
  FROM base b
  JOIN sites s ON s.site_id = b.machine_no % 8
  JOIN sensors se ON se.sensor_id = (b.machine_no // 8) % 6
)
SELECT
  ts,
  'M-' || lpad(CAST(machine_no AS VARCHAR), 4, '0') AS machine_id,
  site,
  sensor_type,
  unit,
  CASE WHEN r3 < 0.005 THEN 'OFFLINE' WHEN r3 < 0.03 THEN 'ERROR' WHEN r3 < 0.10 THEN 'WARNING' ELSE 'OK' END AS status,
  round(site_lat + (r1 - 0.5) * 0.2, 6) AS lat,
  round(site_lon + (r2 - 0.5) * 0.2, 6) AS lon,
  round(base + amp * sin(2 * pi() * hour(ts) / 24.0) * 0.5 + (r1 - 0.5) * amp * 0.4 - amp * (0.2 + r2 * 0.3), 3) AS min_value,
  round(base + amp * sin(2 * pi() * hour(ts) / 24.0) * 0.5 + (r1 - 0.5) * amp * 0.4 + amp * (0.2 + r4 * 0.3)
        + CASE WHEN r3 < 0.03 THEN amp * 1.5 ELSE 0 END, 3) AS max_value,
  round(base + amp * sin(2 * pi() * hour(ts) / 24.0) * 0.5 + (r1 - 0.5) * amp * 0.4, 3) AS avg_value,
  CAST(r4 * 100 AS INTEGER) AS load_pct
FROM enriched
ORDER BY ts;
DROP TABLE sites;
DROP TABLE sensors;
CHECKPOINT;
`);

const count = await con.runAndReadAll(`SELECT count(*) AS n FROM ${table}`);
console.log(`Done: ${count.getRowObjectsJson()[0].n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
