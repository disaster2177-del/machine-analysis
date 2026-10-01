import fs from 'node:fs';
import { config } from './config.js';
import { query } from './db.js';
import { qi } from './nlq/sql.js';

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
  const stat = fs.statSync(config.dbPath);
  const fingerprint = `${config.table}:${stat.size}:${stat.mtimeMs}:${config.maxCategoryValues}`;
  const metaPath = `${config.dbPath}.meta.json`;
  if (fs.existsSync(metaPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (cached.fingerprint === fingerprint) return finalize(cached);
    } catch {
      /* rebuild */
    }
  }

  const t = qi(config.table);
  const described = await query(`DESCRIBE ${t}`, { useCache: false });
  const columns = described.rows.map((r) => ({
    name: r.column_name,
    type: r.column_type,
    kind: kindOf(r.column_type),
  }));
  if (!columns.length) throw new Error(`Table ${config.table} has no columns`);

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
    table: config.table,
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

function finalize(meta) {
  const byName = new Map(meta.columns.map((c) => [c.name, c]));
  const time = meta.timeColumn ? byName.get(meta.timeColumn) : null;
  return {
    ...meta,
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
    columns: schema.columns.map(({ values, ...c }) => ({
      ...c,
      sampleValues: values ? values.slice(0, 12) : undefined,
    })),
  };
}
