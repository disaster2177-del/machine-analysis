// Import your data into the local DuckDB file the app queries.
//
// Files (no extensions needed):
//   node scripts/ingest.js --csv "/data/export/*.csv"
//   node scripts/ingest.js --parquet "/data/export/*.parquet"
//
// Databases (DuckDB downloads the postgres/mysql/sqlite extension the first time,
// so run once while online, or copy ~/.duckdb/extensions to the offline machine):
//   node scripts/ingest.js --postgres "host=localhost dbname=plant user=me password=x" --source-table public.readings
//   node scripts/ingest.js --mysql "host=localhost database=plant user=me password=x" --source-table readings
//   node scripts/ingest.js --sqlite /data/plant.db --source-table readings
//
// Options:
//   --time-column ts     column to sort by (sorted data makes time filters much faster)
//   --rename "Timestamp:ts,Latitude:lat"   rename columns while importing
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from '../src/config.js';
import { qi, ql } from '../src/nlq/sql.js';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const out = path.resolve(arg('--out') ?? config.dbPath);
const table = arg('--table') ?? config.table;
const sourceTable = arg('--source-table');
const timeColumn = arg('--time-column');
const renames = (arg('--rename') ?? '')
  .split(',')
  .filter(Boolean)
  .map((p) => p.split(':'));

let source;
let setup = '';
if (arg('--csv')) source = `read_csv(${ql(arg('--csv'))}, auto_detect = true, union_by_name = true)`;
else if (arg('--parquet')) source = `read_parquet(${ql(arg('--parquet'))}, union_by_name = true)`;
else if (arg('--postgres')) {
  setup = `INSTALL postgres; LOAD postgres; ATTACH ${ql(arg('--postgres'))} AS src (TYPE postgres, READ_ONLY);`;
  source = `src.${sourceTable}`;
} else if (arg('--mysql')) {
  setup = `INSTALL mysql; LOAD mysql; ATTACH ${ql(arg('--mysql'))} AS src (TYPE mysql, READ_ONLY);`;
  source = `src.${sourceTable}`;
} else if (arg('--sqlite')) {
  setup = `INSTALL sqlite; LOAD sqlite; ATTACH ${ql(arg('--sqlite'))} AS src (TYPE sqlite, READ_ONLY);`;
  source = `src.${sourceTable}`;
} else {
  console.error('Specify one of --csv, --parquet, --postgres, --mysql, --sqlite (see header of this file).');
  process.exit(1);
}
if ((arg('--postgres') || arg('--mysql') || arg('--sqlite')) && !sourceTable) {
  console.error('--source-table is required for database sources');
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(`${out}.meta.json`, { force: true });
const t0 = Date.now();
const db = await DuckDBInstance.create(out);
const con = await db.connect();
if (setup) await con.run(setup);

const select = renames.length
  ? `SELECT * RENAME (${renames.map(([a, b]) => `${qi(a)} AS ${qi(b)}`).join(', ')}) FROM ${source}`
  : `SELECT * FROM ${source}`;
console.log(`Importing into ${out} (table "${table}") ...`);
await con.run(`CREATE OR REPLACE TABLE ${qi(table)} AS ${select}${timeColumn ? ` ORDER BY ${qi(timeColumn)}` : ''}`);
await con.run('CHECKPOINT');

const n = (await con.runAndReadAll(`SELECT count(*) AS n FROM ${qi(table)}`)).getRowObjectsJson()[0].n;
const cols = (await con.runAndReadAll(`DESCRIBE ${qi(table)}`)).getRowObjectsJson();
console.log(`Imported ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.table(cols.map((c) => ({ column: c.column_name, type: c.column_type })));
