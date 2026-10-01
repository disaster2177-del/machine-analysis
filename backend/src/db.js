import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from './config.js';
import { LruCache } from './cache.js';

const NUMERIC_STRING_TYPES = /^(BIGINT|UBIGINT|HUGEINT|UHUGEINT|DECIMAL)/;

const cache = new LruCache(config.cacheSize);

// A "generation" is one opened DuckDB instance with its connection pool.
//
// DuckDB file locks are exclusive between processes: while this app has the file open (even
// read-only) another process cannot write to it, and vice versa. So by default the app opens
// the file only while queries run and closes it after IDLE_CLOSE_MS, leaving gaps for your
// ingest process to write. If the writer holds the lock, the app retries for LOCK_WAIT_MS.
// Set HOLD_DB_OPEN=true when nothing else writes the file (fastest: keeps DuckDB's cache warm).
let gen = null;
let opening = null;
let idleTimer = null;
let cacheSignature = null;

/** Size + mtime of the database file and its WAL: changes when new data is written. */
export function fileSignature() {
  return [config.dbPath, `${config.dbPath}.wal`]
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.size}:${st.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createGeneration() {
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(
      `Database not found at ${config.dbPath}. Run "npm run generate:radar" for sample radar data, or set DB_PATH to your DuckDB file.`,
    );
  }
  const deadline = Date.now() + config.lockWaitMs;
  let instance;
  for (let attempt = 0; ; attempt++) {
    try {
      instance = await DuckDBInstance.create(config.dbPath, {
        access_mode: 'READ_ONLY',
        threads: String(config.threads),
        memory_limit: config.memoryLimit,
        // Fully offline and sandboxed: no file/HTTP access from queries, settings locked.
        enable_external_access: 'false',
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
      });
      break;
    } catch (err) {
      if (!/lock/i.test(err.message)) throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `${config.dbPath} is locked by another process (DuckDB allows one process at a time). The writer must close the file between batches. (${err.message.slice(0, 160)})`,
        );
      }
      await sleep(Math.min(1000, 50 * 2 ** attempt));
    }
  }
  const g = { instance, idle: [], waiters: [], active: 0, retired: false, signature: fileSignature() };
  for (let i = 0; i < config.connections; i++) g.idle.push(await instance.connect());
  await g.idle[0].run('SET lock_configuration = true');
  return g;
}

function retire(g) {
  if (!g || g.retired) return;
  g.retired = true;
  for (const c of g.idle.splice(0)) c.closeSync();
  if (g.active === 0) g.instance.closeSync();
}

async function currentGeneration() {
  clearTimeout(idleTimer);
  if (gen && !gen.retired) return gen;
  opening ??= createGeneration().finally(() => {
    opening = null;
  });
  gen = await opening;
  return gen;
}

export async function openDatabase() {
  await currentGeneration();
  scheduleIdleClose();
}

function scheduleIdleClose() {
  if (config.holdDbOpen) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (gen && gen.active === 0 && gen.waiters.length === 0) {
      retire(gen);
      gen = null;
    }
  }, config.idleCloseMs);
  idleTimer.unref?.();
}

/** Has the database file changed since we last looked? Clears cached results if so. */
export async function reloadIfChanged() {
  const sig = fileSignature();
  if (sig === cacheSignature) return false;
  const first = cacheSignature === null;
  cacheSignature = sig;
  cache.clear();
  if (gen && gen.signature !== sig) {
    // Next query opens a fresh instance that sees the new data.
    retire(gen);
    gen = null;
  }
  return !first;
}

async function acquire() {
  const g = await currentGeneration();
  g.active++;
  if (g.idle.length) return { g, conn: g.idle.pop() };
  return new Promise((resolve) => g.waiters.push((conn) => resolve({ g, conn })));
}

function release({ g, conn }) {
  g.active--;
  if (g.retired) {
    conn.closeSync();
    if (g.active === 0) g.instance.closeSync();
    return;
  }
  const next = g.waiters.shift();
  if (next) next(conn);
  else g.idle.push(conn);
  if (g.active === 0) scheduleIdleClose();
}

async function withConnection(fn) {
  const lease = await acquire();
  try {
    return await fn(lease.conn);
  } finally {
    release(lease);
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
  if (fileSignature() !== cacheSignature) await reloadIfChanged();
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
