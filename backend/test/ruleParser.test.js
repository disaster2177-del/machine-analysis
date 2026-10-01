import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestion } from '../src/nlq/ruleParser.js';
import { guardSql } from '../src/nlq/sqlGuard.js';

const columns = [
  { name: 'ts', type: 'TIMESTAMP', kind: 'time', min: '2025-01-01 00:00:00', max: '2025-12-31 23:59:59' },
  { name: 'machine_id', type: 'VARCHAR', kind: 'category', values: ['M-0001', 'M-0002', 'M-0012'] },
  { name: 'site', type: 'VARCHAR', kind: 'category', values: ['Pune', 'Mumbai', 'Delhi'] },
  { name: 'sensor_type', type: 'VARCHAR', kind: 'category', values: ['temperature', 'pressure'] },
  { name: 'status', type: 'VARCHAR', kind: 'category', values: ['OK', 'WARNING', 'ERROR'] },
  { name: 'lat', type: 'DOUBLE', kind: 'numeric', min: 12, max: 29 },
  { name: 'lon', type: 'DOUBLE', kind: 'numeric', min: 72, max: 89 },
  { name: 'min_value', type: 'DOUBLE', kind: 'numeric', min: 0, max: 240 },
  { name: 'max_value', type: 'DOUBLE', kind: 'numeric', min: 3, max: 252 },
];
const schema = {
  table: 'readings',
  rowCount: 1000,
  columns,
  timeColumn: 'ts',
  latColumn: 'lat',
  lonColumn: 'lon',
  timeRange: { min: '2025-01-01 00:00:00', max: '2025-12-31 23:59:59' },
};
const parse = (q) => parseQuestion(q, schema, {});

test('counts all records', () => {
  const p = parse('how many records are there?');
  assert.equal(p.sql, 'SELECT count(*) AS record_count FROM "readings"');
  assert.equal(p.confidence, 'high');
});

test('average by category', () => {
  const p = parse('average max value by site');
  assert.match(p.sql, /SELECT "site", avg\("max_value"\) AS "avg_max_value" FROM "readings" GROUP BY "site"/);
  assert.equal(p.chart.type, 'bar');
});

test('which X has the highest Y -> top 1', () => {
  const p = parse('Which machine has the highest max value?');
  assert.match(p.sql, /GROUP BY "machine_id" ORDER BY "max_max_value" DESC NULLS LAST LIMIT 1$/);
});

test('category values become filters, with negation', () => {
  assert.match(parse('average min_value in Pune').sql, /WHERE "site" = 'Pune'/);
  assert.match(parse('average min_value excluding Delhi and Mumbai').sql, /"site" NOT IN \('Delhi', 'Mumbai'\)/);
});

test('top N with value filter', () => {
  const p = parse('top 5 machines with the most errors');
  assert.match(p.sql, /WHERE "status" = 'ERROR' GROUP BY "machine_id" ORDER BY "record_count" DESC NULLS LAST LIMIT 5/);
});

test('relative dates anchor to the latest data', () => {
  const p = parse('daily average max_value last 7 days');
  assert.match(p.sql, /date_trunc\('day', "ts"\)/);
  assert.match(p.sql, /"ts" >= TIMESTAMP '2025-12-25 00:00:00' AND "ts" < TIMESTAMP '2026-01-01 00:00:00'/);
  assert.equal(p.chart.type, 'line');
});

test('absolute dates and ranges', () => {
  assert.match(parse('count in March 2025').sql, /"ts" >= TIMESTAMP '2025-03-01 00:00:00' AND "ts" < TIMESTAMP '2025-04-01 00:00:00'/);
  assert.match(parse('count between 2025-02-01 and 2025-02-15').sql, /< TIMESTAMP '2025-02-16 00:00:00'/);
  assert.match(parse('count on 05/03/2025').sql, />= TIMESTAMP '2025-03-05 00:00:00'/);
  assert.match(parse('count since 1st june 2025').sql, /"ts" >= TIMESTAMP '2025-06-01 00:00:00'(?! AND "ts" <)/);
});

test('numeric comparisons', () => {
  assert.match(parse('readings where max value above 90').sql, /WHERE "max_value" > 90/);
  assert.match(parse('count where min_value between 10 and 20').sql, /"min_value" BETWEEN 10 AND 20/);
  assert.match(parse('how many readings with max_value at least 50.5').sql, /"max_value" >= 50.5/);
});

test('argmax returns the record', () => {
  const p = parse('when was the highest max value recorded');
  assert.equal(p.mode, 'argmax');
  assert.match(p.sql, /ORDER BY "max_value" DESC NULLS LAST LIMIT 1$/);
});

test('count distinct and having', () => {
  assert.match(parse('how many machines are in Mumbai').sql, /count\(DISTINCT "machine_id"\)/);
  assert.match(parse('machines with more than 100 errors').sql, /GROUP BY "machine_id" HAVING count\(\*\) > 100/);
});

test('geo radius and nearest', () => {
  const p = parse('readings within 5 km of 18.52, 73.85');
  assert.match(p.sql, /"lat" BETWEEN/);
  assert.match(p.sql, /<= 5/);
  assert.match(parse('nearest 3 readings to 19.07, 72.87').sql, /ORDER BY distance_km ASC LIMIT 3/);
});

test('stats, histogram, correlation, percentile', () => {
  assert.equal(parse('summary of max_value').mode, 'summary');
  assert.equal(parse('distribution of max_value').mode, 'histogram');
  assert.match(parse('correlation between min_value and max_value').sql, /corr\("min_value", "max_value"\)/);
  assert.match(parse('95th percentile of max value').sql, /quantile_cont\("max_value", 0.95\)/);
});

test('unknown words lower confidence', () => {
  const p = parse('what is the efficiency of plant');
  assert.notEqual(p.confidence, 'high');
  assert.deepEqual(p.unknownWords.sort(), ['efficiency', 'plant']);
});

test('sql guard', () => {
  assert.equal(guardSql('SELECT 1;'), 'SELECT 1');
  assert.throws(() => guardSql('DROP TABLE readings'));
  assert.throws(() => guardSql('SELECT 1; DELETE FROM readings'));
  assert.throws(() => guardSql("SELECT * FROM read_csv('/etc/passwd')"));
  assert.equal(guardSql("SELECT 'drop table' AS x"), "SELECT 'drop table' AS x");
});
