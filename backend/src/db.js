import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from './config.js';
import { LruCache } from './cache.js';

const NUMERIC_STRING_TYPES = /^(BIGINT|UBIGINT|HUGEINT|UHUGEINT|DECIMAL)/;

let instance;
const idle = [];
const waiters = [];
const cache = new LruCache(config.cacheSize);

export async function openDatabase() {
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(
      `Database not found at ${config.dbPath}. Run "npm run generate" for sample data or "npm run ingest" to import yours.`,
    );
  }
  instance = await DuckDBInstance.create(config.dbPath, {
    access_mode: 'READ_ONLY',
    threads: String(config.threads),
    memory_limit: config.memoryLimit,
    // Fully offline and sandboxed: no file/HTTP access from queries, settings locked.
    enable_external_access: 'false',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  for (let i = 0; i < config.connections; i++) idle.push(await instance.connect());
  await withConnection((c) => c.run('SET lock_configuration = true'));
}

async function acquire() {
  if (idle.length) return idle.pop();
  return new Promise((resolve) => waiters.push(resolve));
}

function release(conn) {
  const next = waiters.shift();
  if (next) next(conn);
  else idle.push(conn);
}

async function withConnection(fn) {
  const conn = await acquire();
  try {
    return await fn(conn);
  } finally {
    release(conn);
  }
}

function toJsonRows(reader) {
  const types = reader.columnTypes().map(String);
  const names = reader.columnNames();
  const numericCols = names.filter((_, i) => NUMERIC_STRING_TYPES.test(types[i]));
  const rows = reader.getRowObjectsJson();
  if (numericCols.length) {
    for (const row of rows) {
      for (const col of numericCols) if (row[col] !== null) row[col] = Number(row[col]);
    }
  }
  return { columns: names.map((name, i) => ({ name, type: types[i] })), rows };
}

/**
 * Run a read-only query. Results are cached by SQL text (the database is opened
 * read-only, so results cannot go stale while the server runs).
 */
export async function query(sql, { maxRows = config.maxResultRows, useCache = true } = {}) {
  const key = `${maxRows}\u0000${sql}`;
  if (useCache) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true, ms: 0 };
  }
  const started = performance.now();
  const result = await withConnection(async (conn) => {
    const timer = setTimeout(() => conn.interrupt(), config.queryTimeoutMs);
    try {
      // Read one row more than allowed so we can tell the user the result was truncated.
      const reader = await conn.streamAndReadUntil(sql, maxRows + 1);
      const out = toJsonRows(reader);
      const truncated = out.rows.length > maxRows;
      if (truncated) out.rows.length = maxRows;
      return { ...out, truncated };
    } catch (err) {
      if (/interrupt/i.test(err.message)) {
        throw new Error(`Query exceeded the ${config.queryTimeoutMs / 1000}s time limit.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
  const ms = Math.round(performance.now() - started);
  if (useCache) cache.set(key, result);
  return { ...result, cached: false, ms };
}
