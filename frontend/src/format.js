const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const compactNf = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

export function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Math.abs(v) < 1 && v !== 0 ? String(Number(v.toPrecision(3))) : nf.format(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2} 00:00:00(\.0+)?$/.test(s) ? s.slice(0, 10) : s.replace(/(\d{2}:\d{2}:\d{2})\.\d+$/, '$1');
}

export const fmtCompact = (v) => (typeof v === 'number' ? (Math.abs(v) >= 1e5 ? compactNf.format(v) : nf.format(Number(v.toPrecision(4)))) : fmt(v));

export function crore(n) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} crore`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} lakh`;
  return nf.format(n);
}

export const parseTs = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
};

export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.5; t += step) ticks.push(+t.toPrecision(12));
  return ticks;
}

export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.name)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.name])).join(','))].join('\n');
}
