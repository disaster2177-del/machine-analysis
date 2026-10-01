// Turn a query result into a short plain-English answer (no LLM required).

const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

export function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) >= 1e7) return `${nf.format(v)} (${(v / 1e7).toFixed(2)} crore)`;
    if (Number.isInteger(v) && Math.abs(v) >= 1e5) return `${nf.format(v)} (${(v / 1e5).toFixed(2)} lakh)`;
    return nf.format(Math.abs(v) < 1 && v !== 0 ? Number(v.toPrecision(3)) : v);
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2} 00:00:00(\.0+)?$/.test(s) ? s.slice(0, 10) : s.replace(/(\d{2}:\d{2}:\d{2})\.\d+$/, '$1');
}

const label = (alias) =>
  alias
    .replace(/^record_count$/, 'number of records')
    .replace(/^distinct_(.+)$/, 'number of distinct $1')
    .replace(/^avg_(.+)$/, 'average $1')
    .replace(/^min_(.+)$/, 'minimum $1')
    .replace(/^max_(.+)$/, 'maximum $1')
    .replace(/^sum_(.+)$/, 'total $1')
    .replace(/^median_(.+)$/, 'median $1')
    .replace(/^stddev_(.+)$/, 'std deviation of $1')
    .replace(/^variance_(.+)$/, 'variance of $1')
    .replace(/^p(\d+)_(.+)$/, '$1th percentile of $2')
    .replace(/^corr_(.+)$/, 'correlation ($1)');

function strength(r) {
  const a = Math.abs(r);
  const dir = r >= 0 ? 'positive' : 'negative';
  if (a >= 0.8) return `very strong ${dir}`;
  if (a >= 0.6) return `strong ${dir}`;
  if (a >= 0.4) return `moderate ${dir}`;
  if (a >= 0.2) return `weak ${dir}`;
  return 'little or no';
}

export function narrate(plan, result, totalCount) {
  const { rows } = result;
  const chart = plan.chart ?? {};
  if (!rows.length) return 'No records match these conditions.';

  if (plan.mode === 'correlation') {
    const key = plan.measureCols[0];
    const r = rows[0][key];
    if (rows.length === 1) return `The correlation is ${fmt(r)} — a ${strength(r)} relationship (based on ${fmt(rows[0].record_count)} records).`;
  }

  if (plan.mode === 'argmax') {
    const row = rows[0];
    const metric = Object.keys(row).find((k) => plan.sql.includes(`ORDER BY "${k}"`));
    const details = Object.entries(row)
      .filter(([k]) => k !== metric)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${fmt(v)}`)
      .join(', ');
    return `${/ASC/.test(plan.sql) ? 'Lowest' : 'Highest'} ${metric} is ${fmt(row[metric])} (${details}).${rows.length > 1 ? ` Showing top ${rows.length}.` : ''}`;
  }

  if (plan.mode === 'list') {
    const total = totalCount ?? rows.length;
    if (plan.chart?.type === 'map' && /distance_km/.test(plan.sql) && /ORDER BY distance_km/.test(plan.sql)) {
      return `Showing the ${rows.length} nearest records; the closest is ${fmt(rows[0].distance_km)} km away.`;
    }
    return total > rows.length
      ? `Found ${fmt(total)} matching records; showing ${rows.length}.`
      : `Found ${fmt(total)} matching record${total === 1 ? '' : 's'}.`;
  }

  if (plan.mode === 'histogram') {
    const total = rows.reduce((s, r) => s + r.record_count, 0);
    const top = rows.reduce((a, b) => (b.record_count > a.record_count ? b : a));
    const w = chart.binWidth;
    return `Most values fall between ${fmt(top.bucket_start)} and ${fmt(top.bucket_start + w)} (${fmt(top.record_count)} records, ${((100 * top.record_count) / total).toFixed(1)}%). Range covered: ${fmt(rows[0].bucket_start)} to ${fmt(rows.at(-1).bucket_start + w)}.`;
  }

  const y = chart.y?.[0] ?? plan.measureCols?.[0];
  if (y && chart.x && chart.type === 'bar' && /LIMIT 1$/.test(plan.sql)) {
    return `**${fmt(rows[0][chart.x])}** has the ${/ASC/.test(plan.sql) ? 'lowest' : 'highest'} ${label(y)}: **${fmt(rows[0][y])}**.`;
  }

  // Single-row aggregate
  if (chart.type === 'stat' || rows.length === 1) {
    const row = rows[0];
    const parts = Object.entries(row).map(([k, v]) => `${label(k)}: **${fmt(v)}**`);
    if (parts.length === 1) return `The ${label(Object.keys(row)[0])} is **${fmt(Object.values(row)[0])}**.`;
    return parts.join(' · ');
  }

  if (chart.type === 'line' && y) {
    if (chart.series) {
      const series = new Set(rows.map((r) => r[chart.series]));
      const periods = new Set(rows.map((r) => r[chart.x]));
      return `${label(y)} for ${series.size} ${chart.series} values across ${periods.size} ${chart.x}s.${result.truncated ? ' (Result truncated; narrow the question for full detail.)' : ''}`;
    }
    const vals = rows.filter((r) => r[y] != null);
    if (!vals.length) return 'No values in this period.';
    const hi = vals.reduce((a, b) => (b[y] > a[y] ? b : a));
    const lo = vals.reduce((a, b) => (b[y] < a[y] ? b : a));
    const mean = vals.reduce((s, r) => s + r[y], 0) / vals.length;
    const first = vals[0][y];
    const last = vals.at(-1)[y];
    const change = first ? ((last - first) / Math.abs(first)) * 100 : null;
    return `Over ${vals.length} ${chart.x}s, ${label(y)} peaked at **${fmt(hi[y])}** on ${fmt(hi[chart.x])} and was lowest at **${fmt(lo[y])}** on ${fmt(lo[chart.x])} (mean ${fmt(mean)}).${change != null ? ` From first to last ${chart.x} it ${change >= 0 ? 'rose' : 'fell'} ${Math.abs(change).toFixed(1)}%.` : ''}`;
  }

  if (y && chart.x) {
    const top = rows[0];
    const lab = (r) => (chart.labels ? chart.labels.map((k) => fmt(r[k])).join(' · ') : fmt(r[chart.x]));
    const groupWord = chart.labels ? 'groups' : `${chart.x} value${rows.length === 1 ? '' : 's'}`;
    const desc = !/ASC/.test(plan.sql);
    const others = rows.slice(1, 3).map((r) => `${lab(r)} (${fmt(r[y])})`);
    const last = rows.at(-1);
    return `**${lab(top)}** is ${desc ? 'highest' : 'lowest'} (${label(y)}: **${fmt(top[y])}**)${others.length ? `, followed by ${others.join(' and ')}` : ''}.${rows.length > 3 ? ` ${desc ? 'Lowest' : 'Highest'} shown: ${lab(last)} (${fmt(last[y])}).` : ''} ${rows.length} ${groupWord} in total.`;
  }
  return `${rows.length} rows returned.`;
}

/** Guess a chart for SQL that did not come from the rule engine. */
export function inferChart(columns, rows, schema) {
  if (!rows.length) return { type: 'table' };
  const isNum = (c) => /INT|DOUBLE|FLOAT|DECIMAL|REAL/.test(c.type);
  const isTime = (c) => /TIMESTAMP|DATE/.test(c.type);
  const nums = columns.filter(isNum);
  const names = columns.map((c) => c.name);
  if (schema.latColumn && schema.lonColumn && names.includes(schema.latColumn) && names.includes(schema.lonColumn) && rows.length > 1) {
    return { type: 'map', lat: schema.latColumn, lon: schema.lonColumn, color: null };
  }
  if (rows.length === 1 && columns.length <= 8) return { type: 'stat' };
  const first = columns[0];
  if (isTime(first) && nums.length) {
    const other = columns.find((c, i) => i > 0 && !isNum(c) && !isTime(c));
    return { type: 'line', x: first.name, y: other ? [nums[0].name] : nums.map((c) => c.name).slice(0, 4), series: other?.name ?? null };
  }
  if (!isNum(first) && nums.length && rows.length <= 200) return { type: 'bar', x: first.name, y: nums.map((c) => c.name).slice(0, 3) };
  return { type: 'table' };
}
