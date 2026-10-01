// Date helpers. All dates are JS Dates whose UTC fields hold the *naive* timestamp
// stored in the database, so no timezone shifting ever happens.

export const UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

export const monthIndex = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase());

export function parseDbTimestamp(value) {
  if (value == null) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatTs(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function formatHuman(d) {
  const s = formatTs(d);
  return s.endsWith(' 00:00:00') ? s.slice(0, 10) : s.slice(0, 16);
}

export function startOf(d, unit) {
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  switch (unit) {
    case 'year':
      return new Date(Date.UTC(y, 0, 1));
    case 'quarter':
      return new Date(Date.UTC(y, mo - (mo % 3), 1));
    case 'month':
      return new Date(Date.UTC(y, mo, 1));
    case 'week': {
      // ISO weeks start on Monday, same as DuckDB date_trunc('week', ...)
      const day = new Date(Date.UTC(y, mo, d.getUTCDate()));
      const dow = (day.getUTCDay() + 6) % 7;
      return new Date(day.getTime() - dow * 86400000);
    }
    case 'day':
      return new Date(Date.UTC(y, mo, d.getUTCDate()));
    case 'hour':
      return new Date(Date.UTC(y, mo, d.getUTCDate(), d.getUTCHours()));
    case 'minute':
      return new Date(Date.UTC(y, mo, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()));
    default:
      return new Date(d.getTime());
  }
}

export function add(d, unit, n) {
  const r = new Date(d.getTime());
  switch (unit) {
    case 'year':
      r.setUTCFullYear(r.getUTCFullYear() + n);
      return r;
    case 'quarter':
      r.setUTCMonth(r.getUTCMonth() + 3 * n);
      return r;
    case 'month':
      r.setUTCMonth(r.getUTCMonth() + n);
      return r;
    case 'week':
      return new Date(r.getTime() + n * 7 * 86400000);
    case 'day':
      return new Date(r.getTime() + n * 86400000);
    case 'hour':
      return new Date(r.getTime() + n * 3600000);
    case 'minute':
      return new Date(r.getTime() + n * 60000);
    case 'second':
      return new Date(r.getTime() + n * 1000);
    default:
      return r;
  }
}

export function normalizeUnit(word) {
  const w = word.toLowerCase().replace(/s$/, '');
  if (['sec', 'second'].includes(w)) return 'second';
  if (['min', 'minute', 'mins'].includes(w)) return 'minute';
  if (['hr', 'hour'].includes(w)) return 'hour';
  if (['day', 'date'].includes(w)) return 'day';
  if (['wk', 'week'].includes(w)) return 'week';
  if (['mon', 'month'].includes(w)) return 'month';
  if (['qtr', 'quarter'].includes(w)) return 'quarter';
  if (['yr', 'year'].includes(w)) return 'year';
  return null;
}

/** Pick a sensible bucket for a trend chart covering [start, end). */
export function autoBucket(start, end) {
  const span = end.getTime() - start.getTime();
  const H = 3600000;
  if (span <= 6 * H) return 'minute';
  if (span <= 7 * 24 * H) return 'hour';
  if (span <= 400 * 24 * H) return 'day';
  if (span <= 6 * 365 * 24 * H) return 'month';
  return 'year';
}
