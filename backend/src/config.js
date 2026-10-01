import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');

// Optional config.json next to package.json; environment variables win.
let fileConfig = {};
const configPath = path.join(backendRoot, 'config.json');
if (fs.existsSync(configPath)) {
  fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const env = (key, fallback) => process.env[key] ?? fileConfig[key] ?? fallback;

export const config = {
  port: Number(env('PORT', 3001)),
  dbPath: path.resolve(backendRoot, env('DB_PATH', 'data/radar.duckdb')),
  table: env('TABLE', 'radar_plots'),

  // Column roles. Leave empty to auto-detect from the schema.
  timeColumn: env('TIME_COLUMN', ''),
  latColumn: env('LAT_COLUMN', ''),
  lonColumn: env('LON_COLUMN', ''),

  // Relative dates ("last 7 days") are anchored to the newest row in the data ("data")
  // or the wall clock ("now"). "data" suits historical datasets.
  relativeTimeAnchor: env('RELATIVE_TIME_ANCHOR', 'data'),
  // How to read ambiguous dates like 03/04/2025: "dmy" or "mdy".
  dateOrder: env('DATE_ORDER', 'dmy'),

  threads: Number(env('DUCKDB_THREADS', os.cpus().length)),
  memoryLimit: env('DUCKDB_MEMORY_LIMIT', `${Math.max(1, Math.floor((os.totalmem() / 1024 ** 3) * 0.75))}GB`),
  connections: Number(env('DUCKDB_CONNECTIONS', 4)),
  queryTimeoutMs: Number(env('QUERY_TIMEOUT_MS', 60000)),
  maxResultRows: Number(env('MAX_RESULT_ROWS', 5000)),
  defaultListLimit: Number(env('DEFAULT_LIST_LIMIT', 100)),
  cacheSize: Number(env('CACHE_SIZE', 500)),
  // Text columns with at most this many distinct values are indexed so that
  // values typed in a question ("Pune", "ERROR") become filters automatically.
  maxCategoryValues: Number(env('MAX_CATEGORY_VALUES', 20000)),

  // Optional local LLM for questions the rule engine cannot parse.
  // provider: "ollama" (default), "openai" (any OpenAI-compatible local server such as
  // llama.cpp server, LM Studio, vLLM) or "none".
  llm: {
    provider: env('LLM_PROVIDER', 'ollama'),
    baseUrl: env('LLM_BASE_URL', 'http://127.0.0.1:11434'),
    model: env('LLM_MODEL', 'qwen2.5-coder:7b'),
    timeoutMs: Number(env('LLM_TIMEOUT_MS', 120000)),
  },

  // Extra words for columns, e.g. {"flight_level": ["alt"], "sensor_id": ["radar head"]}
  columnAliases: (() => {
    const v = env('COLUMN_ALIASES', {});
    return typeof v === 'string' ? JSON.parse(v) : v;
  })(),

  // Radar analysis settings
  radar: {
    pdTarget: Number(env('PD_TARGET', 97)), // % probability of detection to flag sensors against
    trackGapS: Number(env('TRACK_GAP_S', 60)), // a track silent this long is treated as a new track segment
    defaultWindowH: Number(env('RADAR_DEFAULT_WINDOW_H', 24)), // radar analyses look at the last N hours unless a period is given
  },

  // Re-open the database when its file changes (new data written by your ingest process).
  reloadCheckMs: Number(env('RELOAD_CHECK_MS', 15000)),
  // Share the file with a writer process: close it after this much idle time (see db.js).
  holdDbOpen: String(env('HOLD_DB_OPEN', 'false')) === 'true',
  idleCloseMs: Number(env('IDLE_CLOSE_MS', 2000)),
  lockWaitMs: Number(env('LOCK_WAIT_MS', 20000)),

  staticDir: path.resolve(backendRoot, env('STATIC_DIR', '../frontend/dist')),
};
