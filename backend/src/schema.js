import fs from 'node:fs';
import { config } from './config.js';
import { fileSignature, query } from './db.js';
import { qi } from './nlq/sql.js';
import { radarField, isRadarSchema } from './radar/fields.js';

/** Use the configured table, or fall back to the only/most likely table in the file. */
async function resolveTable() {
  const tables = (
    await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`, { useCache: false })
  ).rows.map((r) => r.table_name);
  if (tables.includes(config.table)) return config.table;
  const fallback = ['radar_plots', 'readings'].find((t) => tables.includes(t)) ?? tables[0];
  if (!fallback) throw new Error(`No tables found in ${config.dbPath}`);
  console.warn(`Table "${config.table}" not found; using "${fallback}" (set TABLE to choose another).`);
  return fallback;
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)/;
const TIME = /^(TIMESTAMP|DATE|DATETIME)/;
const TEXT = /^(VARCHAR|TEXT|STRING|ENUM|UUID)/;

function kindOf(type) {
  if (TIME.test(type)) return 'time';
  if (NUMERIC.test(type)) return 'numeric';
  if (TEXT.test(type)) return 'text';
  if (type === 'BOOLEAN') return 'boolean';
  return 'other';
}

function pick(columns, explicit, candidates, kind) {
  if (explicit) return columns.find((c) => c.name === explicit)?.name ?? null;
  for (const cand of candidates) {
    const hit = columns.find((c) => c.name.toLowerCase() === cand && (!kind || c.kind === kind));
    if (hit) return hit.name;
  }
  return null;
}

/**
 * Introspect the table once and cache the metadata next to the database file
 * (keyed by size + mtime) so restarts on a 5-crore-row table are instant.
 */
export async function loadSchema() {
  const table = await resolveTable();
  const fingerprint = `${table}:${fileSignature()}:${config.maxCategoryValues}`;
  const metaPath = `${config.dbPath}.meta.json`;
  if (fs.existsSync(metaPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (cached.fingerprint === fingerprint) return finalize(cached);
    } catch {
      /* rebuild */
    }
  }

  const t = qi(table);
  const described = await query(`DESCRIBE ${t}`, { useCache: false });
  const columns = described.rows.map((r) => ({
    name: r.column_name,
    type: r.column_type,
    kind: kindOf(r.column_type),
  }));
  if (!columns.length) throw new Error(`Table ${table} has no columns`);

  const timeColumn =
    pick(columns, config.timeColumn, ['timestamp', 'ts', 'time', 'datetime', 'date_time', 'event_time', 'recorded_at', 'created_at', 'date'], 'time') ??
    columns.find((c) => c.kind === 'time')?.name ??
    null;
  const latColumn = pick(columns, config.latColumn, ['lat', 'latitude'], 'numeric');
  const lonColumn = pick(columns, config.lonColumn, ['lon', 'lng', 'long', 'longitude'], 'numeric');

  // One pass for row count, numeric ranges, time range and text cardinalities.
  const parts = ['count(*) AS __rows'];
  for (const c of columns) {
    if (c.kind === 'numeric' || c.kind === 'time') {
      parts.push(`min(${qi(c.name)}) AS ${qi(`min:${c.name}`)}`, `max(${qi(c.name)}) AS ${qi(`max:${c.name}`)}`);
    }
    if (c.kind === 'text') parts.push(`approx_count_distinct(${qi(c.name)}) AS ${qi(`ndv:${c.name}`)}`);
  }
  const stats = (await query(`SELECT ${parts.join(', ')} FROM ${t}`, { useCache: false })).rows[0];

  for (const c of columns) {
    if (c.kind === 'numeric' || c.kind === 'time') {
      c.min = stats[`min:${c.name}`];
      c.max = stats[`max:${c.name}`];
    }
    if (c.kind === 'text') {
      c.distinct = stats[`ndv:${c.name}`];
      if (c.distinct <= config.maxCategoryValues) {
        const vals = await query(
          `SELECT ${qi(c.name)} AS v, count(*) AS n FROM ${t} WHERE ${qi(c.name)} IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
          { maxRows: config.maxCategoryValues, useCache: false },
        );
        c.kind = 'category';
        c.values = vals.rows.map((r) => r.v);
        c.distinct = c.values.length;
      }
    }
  }

  const meta = {
    fingerprint,
    table,
    rowCount: stats.__rows,
    columns,
    timeColumn,
    latColumn,
    lonColumn,
  };
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch {
    /* read-only filesystem is fine */
  }
  return finalize(meta);
}

/**
 * Cheap refresh after new data arrives: row count, numeric/time ranges and small category
 * lists (sensors, report types...). Large lists (aircraft addresses, callsigns) keep their
 * previous values until the next full rescan.
 */
export async function refreshSchema(prev) {
  const t = qi(prev.table);
  const cols = prev.columns.map(({ aliases, description, standardItem, ...c }) => ({ ...c }));
  const parts = ['count(*) AS __rows'];
  for (const c of cols) {
    if (c.kind === 'numeric' || c.kind === 'time') parts.push(`min(${qi(c.name)}) AS ${qi(`min:${c.name}`)}`, `max(${qi(c.name)}) AS ${qi(`max:${c.name}`)}`);
  }
  const stats = (await query(`SELECT ${parts.join(', ')} FROM ${t}`, { useCache: false })).rows[0];
  for (const c of cols) {
    if (c.kind === 'numeric' || c.kind === 'time') {
      c.min = stats[`min:${c.name}`];
      c.max = stats[`max:${c.name}`];
    }
    if (c.kind === 'category' && c.values.length <= 1000) {
      const vals = await query(`SELECT ${qi(c.name)} AS v, count(*) AS n FROM ${t} WHERE ${qi(c.name)} IS NOT NULL GROUP BY 1 ORDER BY n DESC`, {
        maxRows: config.maxCategoryValues,
        useCache: false,
      });
      c.values = vals.rows.map((r) => r.v);
      c.distinct = c.values.length;
    }
  }
  const { byName, radar, timeRange, ...rest } = prev;
  return finalize({ ...rest, columns: cols, rowCount: stats.__rows });
}

function finalize(meta) {
  const radar = isRadarSchema(meta);
  // Question vocabulary: ASTERIX field aliases for radar tables, plus COLUMN_ALIASES from config.
  const columns = meta.columns.map((c) => ({
    ...c,
    aliases: [...((radar && radarField(c.name)?.aliases) || []), ...(config.columnAliases[c.name] ?? [])],
    description: radar ? radarField(c.name)?.desc : undefined,
    standardItem: radar ? radarField(c.name)?.item : undefined,
  }));
  const byName = new Map(columns.map((c) => [c.name, c]));
  const time = meta.timeColumn ? byName.get(meta.timeColumn) : null;
  return {
    ...meta,
    columns,
    radar,
    byName,
    timeRange: time ? { min: time.min, max: time.max } : null,
  };
}

/** Public, trimmed-down schema for the UI. */
export function publicSchema(schema) {
  return {
    table: schema.table,
    rowCount: schema.rowCount,
    timeColumn: schema.timeColumn,
    latColumn: schema.latColumn,
    lonColumn: schema.lonColumn,
    timeRange: schema.timeRange,
    radar: schema.radar,
    columns: schema.columns.map(({ values, aliases, ...c }) => ({
      ...c,
      sampleValues: values ? values.slice(0, 12) : undefined,
    })),
  };
}
