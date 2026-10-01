// Offline rule-based natural-language -> SQL translator.
//
// The question is rewritten step by step: every phrase we understand (a date range, a
// column name, a value like "Pune", a comparison, ...) is replaced by a marker token and
// recorded in the parse state. What is left over tells us how confident we are.
// It runs in well under a millisecond, so the only cost of a question is the DuckDB query.

import { qi, ql } from './sql.js';
import {
  MONTH_RE,
  add,
  autoBucket,
  formatHuman,
  formatTs,
  monthIndex,
  normalizeUnit,
  parseDbTimestamp,
  startOf,
} from './time.js';

const L = '';
const R = '';
const tok = (kind, id = '') => ` ${L}${kind}${id}${R} `;
const COL = `${L}C(\\d+)${R}`;
const ANY_TOKEN = new RegExp(`${L}[A-Z]\\d*${R}`, 'g');
const NUM = '(-?\\d+(?:\\.\\d+)?)';

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
const NUMWORD = `(\\d+|${Object.keys(WORD_NUMBERS).join('|')})`;
const toNumber = (w) => (/^\d+$/.test(w) ? Number(w) : WORD_NUMBERS[w.toLowerCase()]);

const RECORD_NOUNS = 'records?|rows?|readings?|entries|entry|events?|samples?|logs?|data\\s*points?|observations?|measurements?|details|data|plots?|detections?|target\\s+reports?|reports|hits|returns|messages';

// Words that carry no meaning on their own. Anything not in here (and not otherwise
// understood) is reported back as "not understood" and lowers confidence.
const KNOWN_WORDS = new Set(`
a an the of in on at for to from by with without and or but not no is are was were be been being has have had do does did
what which who whom whose when where why how show list display give get fetch find print view see tell me us my our i we you
please can could would should will shall may might must let lets let's need want like know about all any each every some per
there their them they it its this that these those than then as into over under between across also only just really very
value values data dataset database table overall total much many number amount whole entire across within during throughout
record records row rows reading readings entry entries event events sample samples log logs point points observation observations
measurement measurements details detail info information result results stats stat statistics summary summarise summarize
overview describe profile breakdown split group grouped grouping wise compare comparison versus vs against
count average avg mean median sum min max minimum maximum highest lowest largest smallest biggest greatest peak top bottom most
least fewest distinct unique std stddev stdev standard deviation variance percentile
latest recent newest oldest earliest first last current today yesterday ago since before after until till upto up through
trend trends trending over time series timeline distribution histogram frequency spread correlation correlate correlated relationship relation
sort sorted order ordered rank ranked ascending descending asc desc limit
near nearest closest around close nearby radius km kms kilometer kilometers kilometre kilometres meter meters metre metres mile miles
having except excluding exclude excluded other without non only
plot plots detection detections report reports hits returns messages radar radars
recorded observed measured captured logged reported seen happened occurred occur happen got received generated
`.split(/\s+/).filter(Boolean));

const prepared = new WeakMap();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const compact = (s) => s.toLowerCase().replace(/[\s_\-.]+/g, '');

function aliasesFor(col, schema) {
  const name = col.name;
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .trim();
  const out = new Set([name.toLowerCase(), spaced]);
  const expansions = [
    [/\bmin\b/, 'minimum'], [/\bmax\b/, 'maximum'], [/\bavg\b/, 'average'], [/\btemp\b/, 'temperature'],
    [/\bqty\b/, 'quantity'], [/\bamt\b/, 'amount'], [/\bval\b/, 'value'], [/\bvalue\b/, 'val'],
  ];
  for (const variant of [...out]) {
    for (const [re, rep] of expansions) if (re.test(variant)) out.add(variant.replace(re, rep));
  }
  // "machine_id" -> "machine", "sensor_type" -> "sensor"
  const base = spaced.replace(/\s+(id|code|name|no|number|type|key)$/, '');
  if (base !== spaced && base.length > 2) out.add(base);

  for (const a of col.aliases ?? []) out.add(a.toLowerCase());
  if (name === schema.timeColumn) ['time', 'timestamp', 'date', 'datetime', 'date time'].forEach((a) => out.add(a));
  if (name === schema.latColumn) ['lat', 'latitude'].forEach((a) => out.add(a));
  if (name === schema.lonColumn) ['lon', 'lng', 'longitude'].forEach((a) => out.add(a));
  return [...out];
}

function prepare(schema) {
  if (prepared.has(schema)) return prepared.get(schema);

  // ---- column aliases -------------------------------------------------------------
  const aliasToCols = new Map();
  schema.columns.forEach((col, idx) => {
    for (const alias of aliasesFor(col, schema)) {
      const key = compact(alias);
      if (!key) continue;
      if (!aliasToCols.has(key)) aliasToCols.set(key, { exact: null, cols: new Set(), text: alias });
      const entry = aliasToCols.get(key);
      entry.cols.add(idx);
      if (compact(col.name) === key) entry.exact = idx;
    }
  });
  const aliasIndex = new Map();
  const aliasTexts = [];
  for (const [key, entry] of aliasToCols) {
    // Ambiguous aliases (shared by two columns) are only kept for the exact column name.
    const idx = entry.exact ?? (entry.cols.size === 1 ? [...entry.cols][0] : null);
    if (idx == null) continue;
    aliasIndex.set(key, idx);
    aliasTexts.push(entry.text);
  }
  aliasTexts.sort((a, b) => b.length - a.length);
  const aliasPattern = aliasTexts
    .map((a) => a.split(/[\s_\-.]+/).map(escapeRe).join('[\\s_\\-.]*'))
    .join('|');
  const columnRe = new RegExp(`(?<![\\w${L}${R}])(${aliasPattern})(?:e?s)?(?![\\w])`, 'gi');

  // ---- category values ------------------------------------------------------------
  const valueRes = [];
  schema.columns.forEach((col, idx) => {
    if (!col.values?.length) return;
    const lookup = new Map();
    for (const v of col.values) {
      const s = String(v);
      if (s.length < 2 || /^-?\d+(\.\d+)?$/.test(s) || KNOWN_WORDS.has(s.toLowerCase())) continue;
      if (!lookup.has(s.toLowerCase())) lookup.set(s.toLowerCase(), v);
    }
    if (!lookup.size) return;
    const alts = [...lookup.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    valueRes.push({ idx, lookup, re: new RegExp(`(?<![\\w\\-])(${alts})(?:e?s)?(?![\\w\\-])`, 'gi') });
  });

  const result = { columnRe, aliasIndex, valueRes };
  prepared.set(schema, result);
  return result;
}

// ---------------------------------------------------------------------------------------
// Parse state helpers

function replaceAll(st, re, fn) {
  st.text = st.text.replace(re, (...args) => {
    const out = fn(...args);
    return out == null ? args[0] : out;
  });
}

function addWhere(st, sql, desc, kind = 'value') {
  st.where.push(sql);
  st.whereDesc.push(desc);
  st.whereKinds.push(kind);
}

// ---------------------------------------------------------------------------------------
// Time

function inferYear(month, day, anchor) {
  let y = anchor.getUTCFullYear();
  if (new Date(Date.UTC(y, month, day ?? 1)) > anchor) y -= 1;
  return y;
}

function extractTime(st, schema, anchor, dateOrder) {
  const timeCol = schema.timeColumn;
  if (!timeCol) return;
  const t = qi(timeCol);
  const periods = [];
  const dateTok = (start, end, label) => {
    periods.push({ start, end, label });
    return tok('D', periods.length - 1);
  };

  // --- grouping by time ("per day", "monthly", "trend") ---
  replaceAll(st, /\b(?:per|by|each|every|for\s+(?:each|every)|group(?:ed)?\s+by|on\s+an?)\s+(minute|hour|day|date|week|month|quarter|year)s?\b/gi, (_, u) => {
    st.timeBucket = normalizeUnit(u);
    return tok('G');
  });
  replaceAll(st, /\b(minutely|hourly|daily|weekly|monthly|quarterly|yearly|annually|annual|(?:minute|hour|day|date|week|month|quarter|year)[\s-]*wise)\b/gi, (_, w) => {
    const map = { minutely: 'minute', hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year', annually: 'year', annual: 'year' };
    st.timeBucket = map[w.toLowerCase()] ?? normalizeUnit(w.replace(/[\s-]*wise$/i, ''));
    return tok('G');
  });
  replaceAll(st, /\b(?:which|what)\s+(minute|hour|day|date|week|month|quarter|year)\b/gi, (_, u) => {
    st.timeBucket = normalizeUnit(u);
    st.whichTime = true;
    return tok('G');
  });
  replaceAll(st, /\b(trends?|trending|over\s+time|time[\s-]*series|timeline|over\s+the\s+(?:period|time|days|weeks|months|years|hours))\b/gi, () => {
    st.autoTrend = true;
    return tok('G');
  });

  // --- absolute dates ---
  const day = (y, m, d) => {
    const s = new Date(Date.UTC(y, m, d));
    return [s, add(s, 'day', 1)];
  };
  replaceAll(st, /\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/gi, (m, y, mo, d, hh, mm, ss) => {
    if (hh != null) {
      const s = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss ?? 0)));
      return dateTok(s, add(s, ss != null ? 'second' : 'minute', 1), m.trim());
    }
    const [s, e] = day(+y, +mo - 1, +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g, (_, y, mo, d) => {
    const [s, e] = day(+y, +mo - 1, +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, (_, a, b, y) => {
    let [d, mo] = dateOrder === 'mdy' ? [+b, +a] : [+a, +b];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    const [s, e] = day(+y, mo - 1, d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}[,']?\\s+(\\d{4})\\b`, 'gi'), (_, d, mon, y) => {
    const [s, e] = day(+y, monthIndex(mon), +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (_, mon, d, y) => {
    const [s, e] = day(+y, monthIndex(mon), +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, new RegExp(`\\b${MONTH_RE}[,']?\\s*(\\d{4})\\b`, 'gi'), (_, mon, y) => {
    const s = new Date(Date.UTC(+y, monthIndex(mon), 1));
    return dateTok(s, add(s, 'month', 1), `${mon} ${y}`);
  });
  replaceAll(st, new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'gi'), (_, d, mon) => {
    const mi = monthIndex(mon);
    const [s, e] = day(inferYear(mi, +d, anchor), mi, +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, 'gi'), (_, mon, d) => {
    const mi = monthIndex(mon);
    const [s, e] = day(inferYear(mi, +d, anchor), mi, +d);
    return dateTok(s, e, formatHuman(s));
  });
  replaceAll(st, /\b(?:q([1-4])\s*[,']?\s*(\d{4})|(\d{4})\s*[-\s]?q([1-4]))\b/gi, (_, q1, y1, y2, q2) => {
    const q = +(q1 ?? q2);
    const y = +(y1 ?? y2);
    const s = new Date(Date.UTC(y, (q - 1) * 3, 1));
    return dateTok(s, add(s, 'quarter', 1), `Q${q} ${y}`);
  });
  const PREP = '(?<=\\b(?:in|during|for|of|since|from|to|until|till|before|after|between|and|through|on|year)\\s+(?:the\\s+(?:month|year)\\s+(?:of\\s+)?)?)';
  replaceAll(st, new RegExp(`${PREP}${MONTH_RE}\\b`, 'gi'), (_, mon) => {
    const mi = monthIndex(mon);
    const s = new Date(Date.UTC(inferYear(mi, 1, anchor), mi, 1));
    return dateTok(s, add(s, 'month', 1), `${mon} ${s.getUTCFullYear()}`);
  });
  replaceAll(st, new RegExp(`${PREP}((?:19|20)\\d{2})\\b`, 'gi'), (_, y) => {
    const s = new Date(Date.UTC(+y, 0, 1));
    return dateTok(s, add(s, 'year', 1), y);
  });

  // --- relative dates (anchored to the latest data or "now") ---
  const anchorEnd = add(anchor, 'second', 1);
  replaceAll(st, /\b(?:year[\s-]+to[\s-]+date|ytd|so\s+far\s+this\s+year)\b/gi, () =>
    dateTok(startOf(anchor, 'year'), anchorEnd, 'year to date'));
  replaceAll(st, /\b(?:month[\s-]+to[\s-]+date|mtd|so\s+far\s+this\s+month)\b/gi, () =>
    dateTok(startOf(anchor, 'month'), anchorEnd, 'month to date'));
  replaceAll(st, new RegExp(`\\b(?:in\\s+|during\\s+|over\\s+|for\\s+|within\\s+)?(?:the\\s+)?(?:last|past|previous|prior|recent|latest)\\s+${NUMWORD}\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mons?|quarters?|qtrs?|years?|yrs?|y)\\b`, 'gi'), (m, n, u) => {
    const short = { h: 'hour', d: 'day', w: 'week', y: 'year' };
    const unit = short[u.toLowerCase()] ?? normalizeUnit(u);
    const count = toNumber(n);
    if (!unit || !count) return null;
    return dateTok(add(anchorEnd, unit, -count), anchorEnd, `last ${count} ${unit}${count > 1 ? 's' : ''}`);
  });
  replaceAll(st, /\b(?:in\s+|during\s+|for\s+)?(?:the\s+)?(last|previous|past|this|current)\s+(hour|day|week|month|quarter|year)\b/gi, (m, which, u) => {
    const w = which.toLowerCase();
    if (w === 'past') return dateTok(add(anchorEnd, u.toLowerCase(), -1), anchorEnd, `past ${u}`);
    const cur = startOf(anchor, u.toLowerCase());
    if (w === 'this' || w === 'current') return dateTok(cur, add(cur, u.toLowerCase(), 1), `this ${u}`);
    if (u.toLowerCase() === 'hour') return dateTok(add(anchorEnd, 'hour', -1), anchorEnd, 'last hour');
    return dateTok(add(cur, u.toLowerCase(), -1), cur, `last ${u}`);
  });
  replaceAll(st, new RegExp(`\\b${NUMWORD}\\s+(hours?|days?|weeks?|months?|years?)\\s+ago\\b`, 'gi'), (m, n, u) => {
    const unit = normalizeUnit(u);
    const s = startOf(add(anchor, unit, -toNumber(n)), unit);
    return dateTok(s, add(s, unit, 1), m.trim());
  });
  replaceAll(st, /\bday\s+before\s+yesterday\b/gi, () => {
    const s = add(startOf(anchor, 'day'), 'day', -2);
    return dateTok(s, add(s, 'day', 1), 'day before yesterday');
  });
  replaceAll(st, /\byesterday\b/gi, () => {
    const s = add(startOf(anchor, 'day'), 'day', -1);
    return dateTok(s, add(s, 'day', 1), 'yesterday');
  });
  replaceAll(st, /\btoday\b/gi, () => {
    const s = startOf(anchor, 'day');
    return dateTok(s, add(s, 'day', 1), 'today');
  });
  if (!periods.length) return;

  // --- connect date tokens into ranges ---
  const D = `${L}D(\\d+)${R}`;
  const lit = (d) => `TIMESTAMP '${formatTs(d)}'`;
  const condition = (start, end, label) => {
    const parts = [];
    if (start) parts.push(`${t} >= ${lit(start)}`);
    if (end) parts.push(`${t} < ${lit(end)}`);
    addWhere(st, parts.join(' AND '), `${timeCol} ${label}`, 'time');
    st.timeWindow = { start: start ?? st.timeWindow?.start, end: end ?? st.timeWindow?.end };
    return tok('T');
  };
  replaceAll(st, new RegExp(`\\b(?:between|from)\\s+${D}\\s*(?:and|to|till|until|through|-|–)\\s*${D}`, 'gi'), (_, a, b) =>
    condition(periods[a].start, periods[b].end, `between ${periods[a].label} and ${periods[b].label}`));
  replaceAll(st, new RegExp(`\\b(since|from|starting(?:\\s+from)?|after|post|>=?)\\s+${D}`, 'gi'), (_, w, a) =>
    /after|post|^>$/i.test(w)
      ? condition(periods[a].end, null, `after ${periods[a].label}`)
      : condition(periods[a].start, null, `since ${periods[a].label}`));
  replaceAll(st, new RegExp(`\\b(before|prior\\s+to|until|till|up\\s*to|through|<=?)\\s+${D}`, 'gi'), (_, w, a) =>
    /before|prior|^<$/i.test(w)
      ? condition(null, periods[a].start, `before ${periods[a].label}`)
      : condition(null, periods[a].end, `until ${periods[a].label}`));
  replaceAll(st, new RegExp(`(?:\\b(?:in|on|during|for|of|at|within)\\s+)?${D}`, 'gi'), (_, a) =>
    condition(periods[a].start, periods[a].end, /^last|^past|^this|day|ago|to date/.test(periods[a].label) ? periods[a].label : `in ${periods[a].label}`));
}

// ---------------------------------------------------------------------------------------
// Location

function extractGeo(st, schema) {
  if (!schema.latColumn || !schema.lonColumn) return;
  const COORD = `(?:lat(?:itude)?\\s*[:=]?\\s*)?\\(?\\s*${NUM}\\s*[,\\s]\\s*(?:lon(?:g(?:itude)?)?|lng)?\\s*[:=]?\\s*${NUM}\\s*\\)?`;
  const toKm = (n, unit) => {
    const u = unit.toLowerCase();
    if (/^mi/.test(u)) return n * 1.609344;
    if (/^m(et|$)/.test(u)) return n / 1000;
    return n;
  };
  const valid = (lat, lon) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  replaceAll(st, new RegExp(`\\b(?:within|in\\s+a\\s+radius\\s+of|inside|radius(?:\\s+of)?)\\s+${NUM}\\s*(km|kms|kilomet(?:er|re)s?|m|meters?|metres?|mi|miles?)\\s+(?:of|from|around|near)\\s+${COORD}`, 'gi'), (_, r, unit, lat, lon) => {
    if (!valid(+lat, +lon)) return null;
    st.geo = { lat: +lat, lon: +lon, radiusKm: toKm(+r, unit) };
    return tok('P');
  });
  replaceAll(st, new RegExp(`\\b(nearest|closest|near|around|close\\s+to|nearby)\\s+(?:(?:\\w+\\s+){0,3}?(?:to|from|of)\\s+)?${COORD}`, 'gi'), (m, w, lat, lon) => {
    if (!valid(+lat, +lon)) return null;
    const nearest = /nearest|closest/i.test(w);
    const n = m.match(/^\s*\S+\s+(\d+)\s/);
    if (nearest && n) st.limit = +n[1];
    st.geo = { lat: +lat, lon: +lon, radiusKm: nearest ? null : 5, nearest };
    return tok('P');
  });
  if (!st.geo) return;

  const { lat, lon, radiusKm } = st.geo;
  const la = qi(schema.latColumn);
  const lo = qi(schema.lonColumn);
  st.geo.distanceExpr = `2 * 6371 * asin(sqrt(pow(sin(radians(${la} - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(${la})) * pow(sin(radians(${lo} - ${lon}) / 2), 2)))`;
  if (radiusKm != null) {
    // Bounding box first (cheap, lets DuckDB skip row groups), then exact great-circle distance.
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    addWhere(
      st,
      `${la} BETWEEN ${lat - dLat} AND ${lat + dLat} AND ${lo} BETWEEN ${lon - dLon} AND ${lon + dLon} AND ${st.geo.distanceExpr} <= ${radiusKm}`,
      `within ${+radiusKm.toFixed(3)} km of (${lat}, ${lon})`,
      'geo',
    );
  }
}

// ---------------------------------------------------------------------------------------
// Columns, filters, values

function extractColumns(st, prep) {
  replaceAll(st, prep.columnRe, (m, alias) => {
    const idx = prep.aliasIndex.get(compact(alias));
    return idx == null ? null : tok('C', idx);
  });
}

const OPS = [
  ['between', 'between'],
  ['>=', '>=|=>|at\\s+least|not\\s+less\\s+than|no\\s+less\\s+than|greater\\s+than\\s+or\\s+equal\\s+to|minimum'],
  ['<=', '<=|=<|at\\s+most|not\\s+more\\s+than|no\\s+more\\s+than|less\\s+than\\s+or\\s+equal\\s+to|up\\s*to|not\\s+exceeding|maximum'],
  ['!=', '!=|<>|not\\s+equal(?:\\s+to)?|is\\s+not|isn\'t|other\\s+than'],
  ['>', '>|above|over|greater\\s+than|more\\s+than|higher\\s+than|bigger\\s+than|larger\\s+than|exceed(?:s|ed|ing)?|beyond|cross(?:es|ed|ing)?|went\\s+above|goes\\s+above|rose\\s+above|>\\s*than'],
  ['<', '<|below|under|less\\s+than|lower\\s+than|smaller\\s+than|beneath|(?:dropped|drops|fell|falls|went|goes)\\s+below'],
  ['=', '==|=|equals?(?:\\s+to)?|exactly|is|was'],
];
const OP_RE = OPS.map(([, re]) => `(${re})`).join('|');

function opFromGroups(groups) {
  for (let i = 0; i < OPS.length; i++) if (groups[i]) return OPS[i][0];
  return null;
}

function extractComparisons(st, schema) {
  const cols = schema.columns;
  const FILL = '(?:\\s+(?:values?|readings?|reading|level|is|was|are|were|has|had|have|been|being|that|which|stays?|remains?|goes|went|got|gets))*';
  const re = new RegExp(`${COL}${FILL}\\s*(?:${OP_RE})\\s*${NUM}(?:\\s*(?:and|to|-|–)\\s*${NUM})?`, 'gi');
  replaceAll(st, re, (...args) => {
    const idx = +args[1];
    const col = cols[idx];
    if (col.kind !== 'numeric') return null;
    const op = opFromGroups(args.slice(2, 2 + OPS.length));
    const a = args[2 + OPS.length];
    const b = args[3 + OPS.length];
    const c = qi(col.name);
    if (op === 'between') {
      if (b == null) return null;
      const [lo, hi] = [Math.min(+a, +b), Math.max(+a, +b)];
      addWhere(st, `${c} BETWEEN ${lo} AND ${hi}`, `${col.name} between ${lo} and ${hi}`, 'compare');
    } else {
      addWhere(st, `${c} ${op} ${+a}`, `${col.name} ${op} ${+a}`, 'compare');
    }
    st.filterCols.add(idx);
    return tok('F');
  });
  // aviation style, operator first: "below FL 50", "above flight level 300"
  const PRE_OPS = OPS.filter(([op]) => ['>', '<', '>=', '<='].includes(op));
  replaceAll(st, new RegExp(`\\b(?:${PRE_OPS.map(([, re]) => `(${re})`).join('|')})\\s+${COL}\\s*${NUM}`, 'gi'), (...args) => {
    const opIdx = args.slice(1, 1 + PRE_OPS.length).findIndex(Boolean);
    const idx = +args[1 + PRE_OPS.length];
    const n = +args[2 + PRE_OPS.length];
    const col = cols[idx];
    if (opIdx < 0 || col.kind !== 'numeric') return null;
    const op = PRE_OPS[opIdx][0];
    addWhere(st, `${qi(col.name)} ${op} ${n}`, `${col.name} ${op} ${n}`, 'compare');
    st.filterCols.add(idx);
    return tok('F');
  });
  replaceAll(st, new RegExp(`${COL}\\s+(?:no\\.?\\s*|number\\s+|#\\s*|id\\s+)?(\\d+)\\b(?!\\s*(?:%|${L}|seconds?|minutes?|hours?|days?|weeks?|months?|years?|km|nm|ft|kt))`, 'gi'), (m, i, n) => {
    const col = cols[+i];
    if (col.kind !== 'numeric' || !/INT/.test(col.type) || !/number|_id$|_no$|code|^id$/i.test(col.name)) return null;
    addWhere(st, `${qi(col.name)} = ${+n}`, `${col.name} = ${+n}`);
    st.filterCols.add(+i);
    return tok('F');
  });
}

function extractTextFilters(st, schema) {
  const cols = schema.columns;
  const textish = (idx) => ['text', 'category'].includes(cols[idx].kind);
  const like = (v) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
  // machine_id contains 'abc'
  replaceAll(st, new RegExp(`${COL}\\s+(?:contains?|containing|includes?|including|like|matching|matches)\\s+(?:'([^']+)'|"([^"]+)"|([\\w\\-.:/]+))`, 'gi'), (_, i, q1, q2, w) => {
    if (!textish(+i)) return null;
    const v = q1 ?? q2 ?? w;
    addWhere(st, `${qi(cols[i].name)} ILIKE ${ql(`%${like(v)}%`)} ESCAPE '\\'`, `${cols[i].name} contains "${v}"`);
    st.filterCols.add(+i);
    return tok('F');
  });
  replaceAll(st, new RegExp(`${COL}\\s+(starts?|starting|begins?|beginning|ends?|ending)\\s+with\\s+(?:'([^']+)'|"([^"]+)"|([\\w\\-.:/]+))`, 'gi'), (_, i, kind, q1, q2, w) => {
    if (!textish(+i)) return null;
    const v = q1 ?? q2 ?? w;
    const starts = /^(start|begin)/i.test(kind);
    addWhere(st, `${qi(cols[i].name)} ILIKE ${ql(starts ? `${like(v)}%` : `%${like(v)}`)} ESCAPE '\\'`, `${cols[i].name} ${starts ? 'starts' : 'ends'} with "${v}"`);
    st.filterCols.add(+i);
    return tok('F');
  });
  // machine_id = 'M-0001', machine id is "abc", machine M-0012 (identifier containing a digit)
  replaceAll(st, new RegExp(`${COL}\\s*(?:(!=|<>|is\\s+not|not)\\s*|(?:=|==|is|equals?|:|named|called)\\s*)?(?:'([^']+)'|"([^"]+)")`, 'gi'), (_, i, neg, q1, q2) => {
    if (!textish(+i)) return null;
    const v = q1 ?? q2;
    addWhere(st, `${qi(cols[i].name)} ${neg ? '!=' : '='} ${ql(v)}`, `${cols[i].name} ${neg ? '≠' : '='} "${v}"`);
    st.filterCols.add(+i);
    return tok('F');
  });
  replaceAll(st, new RegExp(`${COL}\\s*(?:(?:=|==|:|equals?)\\s*([\\w\\-.:/]+)|(?:no\\.?|number|#)?\\s*([A-Za-z]*\\d[\\w\\-.:/]*))`, 'gi'), (_, i, v1, v2) => {
    const v = v1 ?? v2;
    const knownValue = cols[+i].kind === 'category' && cols[+i].values?.some((x) => String(x).toLowerCase() === v.toLowerCase());
    if (cols[+i].kind !== 'text' && !(cols[+i].kind === 'category' && (v1 || knownValue))) return null;
    addWhere(st, `${qi(cols[i].name)} ILIKE ${ql(like(v))} ESCAPE '\\'`, `${cols[i].name} = "${v}"`);
    st.filterCols.add(+i);
    return tok('F');
  });
}

function extractValues(st, prep, schema) {
  const hits = [];
  for (const { idx, lookup, re } of prep.valueRes) {
    re.lastIndex = 0;
    for (const m of st.text.matchAll(re)) {
      const value = lookup.get(m[1].toLowerCase());
      if (value === undefined) continue;
      hits.push({ idx, value, start: m.index, end: m.index + m[0].length });
    }
  }
  // Longest match wins on overlaps.
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen = [];
  for (const h of hits) if (!chosen.some((c) => h.start < c.end && c.start < h.end)) chosen.push(h);
  chosen.sort((a, b) => a.start - b.start);

  const byCol = new Map();
  let prev = null;
  for (const h of chosen) {
    const before = st.text.slice(Math.max(0, h.start - 40), h.start);
    let negated = /(?:\bnot|\bexcept|\bexcluding|\bexclude|\bother\s+than|\bwithout|\bnon|\bbut\s+not|!=|<>)[\s-]*(?:in|at|from|for|of|the|equal\s+to|=|status|type)?\s*$/i.test(before);
    if (!negated && prev && prev.idx === h.idx && prev.negated) {
      const gap = st.text.slice(prev.end, h.start);
      if (/^[\s,]*(?:and|or|&|nor)?[\s,]*$/i.test(gap)) negated = true;
    }
    h.negated = negated;
    prev = h;
    if (!byCol.has(h.idx)) byCol.set(h.idx, { include: [], exclude: [] });
    const entry = byCol.get(h.idx);
    const list = negated ? entry.exclude : entry.include;
    if (!list.includes(h.value)) list.push(h.value);
  }
  for (const h of [...chosen].reverse()) st.text = `${st.text.slice(0, h.start)}${tok('V', h.idx)}${st.text.slice(h.end)}`;

  for (const [idx, { include, exclude }] of byCol) {
    const name = schema.columns[idx].name;
    const c = qi(name);
    if (include.length === 1) addWhere(st, `${c} = ${ql(include[0])}`, `${name} = "${include[0]}"`);
    if (include.length > 1) addWhere(st, `${c} IN (${include.map(ql).join(', ')})`, `${name} in (${include.join(', ')})`);
    if (exclude.length === 1) addWhere(st, `${c} != ${ql(exclude[0])}`, `${name} ≠ "${exclude[0]}"`);
    if (exclude.length > 1) addWhere(st, `${c} NOT IN (${exclude.map(ql).join(', ')})`, `${name} not in (${exclude.join(', ')})`);
    st.filterCols.add(idx);
    if (include.length > 1) st.multiValueCol = idx;
  }
}

// "machines with more than 50 errors" -> HAVING count(*) > 50
function extractHaving(st) {
  const re = new RegExp(`\\b(more\\s+than|over|above|greater\\s+than|at\\s+least|fewer\\s+than|less\\s+than|under|below|at\\s+most)\\s+(\\d+)\\s+(?:(?:${L}V\\d+${R})\\s*(?:${RECORD_NOUNS}|times|occurrences|alerts?|alarms?)?|(?:${RECORD_NOUNS}|times|occurrences|alerts?|alarms?)\\b)`, 'gi');
  replaceAll(st, re, (m, w, n) => {
    const op = /more|over|above|greater/i.test(w) ? '>' : /at\s+least/i.test(w) ? '>=' : /at\s+most/i.test(w) ? '<=' : '<';
    st.having = { op, n: +n };
    const vt = m.match(new RegExp(`${L}V\\d+${R}`));
    return vt ? ` ${vt[0]} ${tok('H')}` : tok('H');
  });
}

// ---------------------------------------------------------------------------------------
// Grouping, ordering, limits

function extractSortAndGroups(st, schema) {
  const cols = schema.columns;
  const AGGW = '(average|avg|mean|median|sum|total|min(?:imum)?|max(?:imum)?|count)';
  replaceAll(st, new RegExp(`\\b(?:sort(?:ed)?|order(?:ed)?|rank(?:ed)?|arrange(?:d)?)\\s+(?:it\\s+|them\\s+|results?\\s+)?by\\s+(?:the\\s+)?(?:${AGGW}\\s+(?:of\\s+)?)?${COL}(?:\\s+(asc(?:ending)?|desc(?:ending)?|(?:highest|largest|biggest)\\s+first|(?:lowest|smallest)\\s+first|increasing|decreasing))?`, 'gi'), (_, agg, i, dir) => {
    st.sort = { idx: +i, agg: agg?.toLowerCase(), dir: dir && /^(asc|lowest|smallest|increasing)/i.test(dir) ? 'ASC' : 'DESC' };
    return tok('O');
  });

  const COLS_LIST = `(${COL}(?:\\s*(?:,|and|&|\\+)\\s*${COL})*)`;
  const takeGroupCols = (list) => {
    const ids = [...list.matchAll(new RegExp(COL, 'g'))].map((m) => +m[1]);
    return ids;
  };
  replaceAll(st, new RegExp(`\\b(group(?:ed)?\\s+by|break(?:\\s*down)?\\s+by|breakdown\\s+(?:by|of)|split\\s+by|segment(?:ed)?\\s+by|by|per|for\\s+(?:each|every|all|different)|each|every|across(?:\\s+all)?|among|between|within\\s+each)\\s+(?:the\\s+)?(?:different\\s+|individual\\s+)?${COLS_LIST}`, 'gi'), (m, kw, list) => {
    const ids = takeGroupCols(list);
    const explicit = /group|break|split|segment/i.test(kw);
    const keep = ids.filter((i) => cols[i].kind !== 'numeric' || explicit);
    if (!keep.length) return null;
    for (const i of keep) if (!st.groupCols.includes(i)) st.groupCols.push(i);
    const rest = ids.filter((i) => !keep.includes(i)).map((i) => tok('C', i)).join(' ');
    return `${tok('B')}${rest}`;
  });
  replaceAll(st, new RegExp(`${COL}[\\s-]*wise\\b`, 'gi'), (_, i) => {
    if (!st.groupCols.includes(+i)) st.groupCols.push(+i);
    return tok('B');
  });
  // "which machine ...", "what site ..." -> group by that column (a superlative later sets order/limit)
  replaceAll(st, new RegExp(`\\b(which|what|whichever)\\s+(?:of\\s+the\\s+)?${COL}`, 'gi'), (m, w, i) => {
    if (cols[+i].kind === 'numeric' || +i === schema.columns.findIndex((c) => c.name === schema.timeColumn)) return null;
    if (!st.groupCols.includes(+i)) st.groupCols.push(+i);
    st.which = true;
    return tok('B');
  });
  // "top 5 machines", "10 sites with the most errors"
  replaceAll(st, new RegExp(`\\b(top|bottom|best|worst|highest|lowest|first|last)?\\s*(\\d+)\\s+${COL}\\b`, 'gi'), (m, w, n, i) => {
    if (!['category', 'text'].includes(cols[+i].kind)) return null;
    if (!st.groupCols.includes(+i)) st.groupCols.push(+i);
    st.limit = +n;
    if (w) st.superlatives.push(/bottom|worst|lowest/i.test(w) ? 'low' : 'high');
    return tok('B');
  });
  replaceAll(st, new RegExp(`${COL}\\s+(?:with|having|that\\s+(?:has|have|had)|has|have|had)\\s+(?:the\\s+)?(most|highest|largest|biggest|maximum|max|least|fewest|lowest|smallest|minimum|min)\\b`, 'gi'), (m, i, w) => {
    if (!['category', 'text'].includes(cols[+i].kind)) return null;
    if (!st.groupCols.includes(+i)) st.groupCols.push(+i);
    return `${tok('B')} ${w}`;
  });
}

function extractLimit(st) {
  replaceAll(st, /\b(top|bottom|first|last|latest|recent|newest|oldest|earliest|highest|lowest|best|worst|largest|smallest|limit(?:\s+to)?|only)\s+(\d+)\b/gi, (m, w, n) => {
    st.limit = +n;
    st.limitWord = w.toLowerCase();
    return ` ${w} `;
  });
  replaceAll(st, /\b(\d+)\s+(highest|lowest|latest|most\s+recent|newest|oldest|earliest|largest|smallest|biggest|top|bottom|first|last)\b/gi, (m, n, w) => {
    st.limit = +n;
    st.limitWord = w.toLowerCase();
    return ` ${w} `;
  });
}

// ---------------------------------------------------------------------------------------
// Measures

const AGG_RE = /\b(average|avg|mean|median|sum|total|minimum|maximum|min|max|std(?:dev)?|stdev|standard\s+deviation|variance|(\d{1,2})(?:st|nd|rd|th)?\s+percentile|p(\d{2})|count|how\s+many|number\s+of|no\.?\s+of|distinct|unique|highest|largest|biggest|greatest|peak|top|most|maximal|lowest|smallest|least|bottom|fewest|minimal)\b/gi;

function classifyAgg(m, text, endPos) {
  const w = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (['average', 'avg', 'mean'].includes(w)) return { type: 'agg', fn: 'avg' };
  if (w === 'median') return { type: 'agg', fn: 'median' };
  if (w === 'sum') return { type: 'agg', fn: 'sum' };
  if (w === 'total') {
    const next = text.slice(endPos);
    return new RegExp(`^\\s*(?:of\\s+)?(?:the\\s+)?${COL}`).test(next) ? { type: 'agg', fn: 'sum', soft: true } : { type: 'count' };
  }
  if (['min', 'minimum'].includes(w)) return { type: 'agg', fn: 'min' };
  if (['max', 'maximum'].includes(w)) return { type: 'agg', fn: 'max' };
  if (/^std|standard/.test(w)) return { type: 'agg', fn: 'stddev' };
  if (w === 'variance') return { type: 'agg', fn: 'variance' };
  if (m[2] || m[3]) return { type: 'agg', fn: 'quantile', q: Number(m[2] ?? m[3]) / 100 };
  if (['count', 'how many', 'number of', 'no of', 'no. of'].includes(w)) return { type: 'count' };
  if (['distinct', 'unique'].includes(w)) return { type: 'distinct' };
  if (['highest', 'largest', 'biggest', 'greatest', 'peak', 'top', 'most', 'maximal'].includes(w)) return { type: 'sup', dir: 'high' };
  return { type: 'sup', dir: 'low' };
}

function defaultAggFor(col) {
  const n = col.name.toLowerCase();
  if (/^max|max$|_max|peak|highest/.test(n)) return 'max';
  if (/^min|min$|_min|lowest/.test(n)) return 'min';
  return 'avg';
}

function aggSql(fn, col, q) {
  const c = qi(col.name);
  switch (fn) {
    case 'median':
      return `median(${c})`;
    case 'quantile':
      return `quantile_cont(${c}, ${q})`;
    case 'stddev':
      return `stddev_samp(${c})`;
    case 'variance':
      return `var_samp(${c})`;
    default:
      return `${fn}(${c})`;
  }
}

const AGG_LABEL = { avg: 'average', min: 'minimum', max: 'maximum', sum: 'total', median: 'median', stddev: 'std deviation', variance: 'variance' };
const aggLabel = (fn, q) => (fn === 'quantile' ? `${Math.round(q * 100)}th percentile` : AGG_LABEL[fn] ?? fn);
const aggAlias = (fn, colName, q) => `${fn === 'quantile' ? `p${Math.round(q * 100)}` : fn}_${colName}`;

// ---------------------------------------------------------------------------------------

export function parseQuestion(question, schema, options = {}) {
  const prep = prepare(schema);
  const cols = schema.columns;
  const table = qi(schema.table);
  const anchor =
    options.anchor ??
    (options.relativeTimeAnchor === 'now'
      ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      : parseDbTimestamp(schema.timeRange?.max)) ??
    new Date();
  const listLimit = options.defaultListLimit ?? 100;

  const st = {
    text: ` ${String(question).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()} `,
    where: [],
    whereDesc: [],
    whereKinds: [],
    filterCols: new Set(),
    groupCols: [],
    superlatives: [],
    timeBucket: null,
  };

  extractGeo(st, schema);
  extractTime(st, schema, anchor, options.dateOrder ?? 'dmy');
  extractColumns(st, prep);
  extractComparisons(st, schema);
  extractTextFilters(st, schema);
  extractValues(st, prep, schema);
  extractHaving(st);
  extractSortAndGroups(st, schema);
  extractLimit(st);

  const text = st.text;
  const lower = text.toLowerCase();

  // ---- intents from remaining words ----
  const has = (re) => re.test(lower);
  const intent = {
    list: has(new RegExp(`\\b(show|list|display|give|get|fetch|find|print|view|see|pull|return|retrieve)\\b`)) || has(/\b(latest|recent|newest|oldest|earliest)\b/),
    recordNoun: has(new RegExp(`\\b(${RECORD_NOUNS})\\b`)),
    when: has(/\b(when|what\s+time|at\s+what\s+time|which\s+(?:record|reading|row|entry|event|time|timestamp)|where\s+(?:was|is|were|did|do))\b/),
    summary: has(/\b(summary|summari[sz]e|statistics|stats|describe|overview|profile)\b/),
    distribution: has(/\b(distribution|histogram|frequency|spread)\b/),
    correlation: has(/\b(correlat\w*|relationship|relation)\b/),
    compare: has(/\b(compare|comparison|versus|vs\.?)\b/),
  };

  // ---- aggregation keywords with positions ----
  const aggHits = [];
  for (const m of text.matchAll(AGG_RE)) aggHits.push({ ...classifyAgg(m, text, m.index + m[0].length), pos: m.index });
  for (const s of st.superlatives) aggHits.push({ type: 'sup', dir: s, pos: -1 });
  const supDir = aggHits.find((h) => h.type === 'sup')?.dir ?? null;
  const countHit = aggHits.find((h) => h.type === 'count');

  // ---- remaining column mentions ----
  const colTokens = [...text.matchAll(new RegExp(COL, 'g'))].map((m) => ({ idx: +m[1], pos: m.index }));
  const timeIdx = cols.findIndex((c) => c.name === schema.timeColumn);
  const metricTokens = colTokens.filter((t) => cols[t.idx].kind === 'numeric');
  const otherTokens = colTokens.filter((t) => cols[t.idx].kind !== 'numeric' && t.idx !== timeIdx && !st.groupCols.includes(t.idx));

  // Distribution / count of a category column becomes a group-by ("distribution of status").
  if ((intent.distribution || (countHit && /\b(by|per|each)\b/.test(lower))) && !st.groupCols.length && otherTokens.length && !metricTokens.length) {
    st.groupCols.push(otherTokens[0].idx);
  }
  // "compare Pune and Mumbai" / several values of one column with an aggregate -> group by it.
  if (st.multiValueCol != null && !st.groupCols.length && (intent.compare || aggHits.some((h) => h.type === 'agg') || countHit)) {
    st.groupCols.push(st.multiValueCol);
  }

  // Measures: each numeric column gets the aggregation words that precede it.
  const measures = [];
  let prevPos = -1;
  let inherited = null;
  for (const t of metricTokens) {
    const span = aggHits.filter((h) => h.pos > prevPos && h.pos < t.pos);
    let fns = span.filter((h) => h.type === 'agg').map((h) => ({ fn: h.fn, q: h.q, explicit: true }));
    if (!fns.length && span.some((h) => h.type === 'sup')) fns = [{ fn: span.find((h) => h.type === 'sup').dir === 'high' ? 'max' : 'min' }];
    if (!fns.length && span.some((h) => h.type === 'distinct')) fns = [{ fn: 'distinct' }];
    if (!fns.length && inherited) fns = inherited;
    // aggregation word after the column: "max_value average"
    if (!fns.length) {
      const after = aggHits.find((h) => h.type === 'agg' && h.pos > t.pos && !metricTokens.some((o) => o.pos > t.pos && o.pos < h.pos));
      if (after) fns = [{ fn: after.fn, q: after.q, explicit: true }];
    }
    if (fns.length) inherited = fns;
    else fns = [{ fn: defaultAggFor(cols[t.idx]) }];
    for (const f of fns) {
      if (!measures.some((m) => m.idx === t.idx && m.fn === f.fn && m.q === f.q)) measures.push({ idx: t.idx, ...f, explicit: !!f.explicit });
    }
    prevPos = t.pos;
  }

  const explicitAgg = aggHits.some((h) => h.type === 'agg');
  // "machines with more than 10 errors" -> group by the mentioned column
  if (st.having && !st.groupCols.length && otherTokens.length) st.groupCols.push(otherTokens.shift().idx);
  const recognized = [];
  const notes = [];
  let mode;
  if (intent.correlation && new Set(metricTokens.map((t) => t.idx)).size >= 2) mode = 'correlation';
  else if (intent.distribution && metricTokens.length && !st.groupCols.length) mode = 'histogram';
  else if (intent.summary) mode = 'summary';
  else if (st.groupCols.length || st.timeBucket || st.autoTrend) mode = 'aggregate';
  else if (countHit && !measures.some((m) => m.explicit)) mode = 'aggregate';
  else if (metricTokens.length && supDir && !explicitAgg && (intent.when || intent.list || intent.recordNoun || st.limit)) mode = 'argmax';
  else if (explicitAgg || (metricTokens.length && supDir) || st.having) mode = 'aggregate';
  else if (st.geo?.nearest) mode = 'list';
  else if (intent.list || intent.recordNoun || st.limit) mode = 'list';
  else if (metricTokens.length) mode = 'aggregate';
  else if (st.where.length) mode = 'list';
  else mode = 'unknown';

  const where = st.where.length ? ` WHERE ${st.where.join(' AND ')}` : '';
  const select = [];
  const groupBy = [];
  const orderBy = [];
  let limit = null;
  let chart = { type: 'table' };
  let countSql = null;
  const describe = [];

  // ---- time bucketing ----
  let bucketAlias = null;
  if ((mode === 'aggregate' || mode === 'summary') && (st.timeBucket || st.autoTrend) && schema.timeColumn) {
    let unit = st.timeBucket;
    if (!unit) {
      const s = st.timeWindow?.start ?? parseDbTimestamp(schema.timeRange?.min);
      const e = st.timeWindow?.end ?? parseDbTimestamp(schema.timeRange?.max);
      unit = s && e ? autoBucket(s, e) : 'day';
    }
    bucketAlias = unit;
    select.push(`date_trunc('${unit}', ${qi(schema.timeColumn)}) AS ${qi(unit)}`);
    groupBy.push(qi(unit));
    describe.push(`per ${unit}`);
  }

  const groupNames = st.groupCols.map((i) => cols[i].name);
  for (const g of groupNames) {
    select.push(qi(g));
    groupBy.push(qi(g));
  }
  if (groupNames.length) describe.push(`grouped by ${groupNames.join(', ')}`);

  const measureCols = [];
  if (mode === 'correlation') {
    const ids = [...new Set(metricTokens.map((t) => t.idx))];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const alias = `corr_${cols[ids[i]].name}_${cols[ids[j]].name}`;
        select.push(`corr(${qi(cols[ids[i]].name)}, ${qi(cols[ids[j]].name)}) AS ${qi(alias)}`);
        measureCols.push(alias);
      }
    }
    select.push('count(*) AS record_count');
    describe.unshift(`correlation between ${ids.map((i) => cols[i].name).join(' and ')}`);
    recognized.push('correlation');
  } else if (mode === 'histogram') {
    const col = cols[metricTokens[0].idx];
    const lo = Number(col.min ?? 0);
    const hi = Number(col.max ?? lo + 1);
    const raw = (hi - lo) / 20 || 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const width = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((w) => w >= raw);
    select.push(`floor(${qi(col.name)} / ${width}) * ${width} AS bucket_start`, 'count(*) AS record_count');
    const w = `${where ? `${where} AND` : ' WHERE'} ${qi(col.name)} IS NOT NULL`;
    const sql = `SELECT ${select.join(', ')} FROM ${table}${w} GROUP BY 1 ORDER BY 1`;
    describe.unshift(`distribution of ${col.name} (bins of ${width})`);
    return finish({ sql, mode, chart: { type: 'bar', x: 'bucket_start', y: ['record_count'], histogram: true, binWidth: width }, measureCols: ['record_count'] });
  } else if (mode === 'summary') {
    let ids = [...new Set(metricTokens.map((t) => t.idx))];
    if (!ids.length) ids = cols.map((c, i) => i).filter((i) => cols[i].kind === 'numeric' && ![schema.latColumn, schema.lonColumn].includes(cols[i].name));
    select.push('count(*) AS record_count');
    measureCols.push('record_count');
    for (const i of ids) {
      for (const fn of ['min', 'avg', 'max', 'stddev']) {
        const alias = aggAlias(fn, cols[i].name);
        select.push(`${aggSql(fn, cols[i])} AS ${qi(alias)}`);
        measureCols.push(alias);
      }
    }
    if (schema.timeColumn && !groupBy.length) {
      select.push(`min(${qi(schema.timeColumn)}) AS first_${schema.timeColumn}`, `max(${qi(schema.timeColumn)}) AS last_${schema.timeColumn}`);
    }
    describe.unshift(`summary statistics${ids.length ? ` of ${ids.map((i) => cols[i].name).join(', ')}` : ''}`);
    recognized.push('summary');
  } else if (mode === 'aggregate') {
    const countTarget = otherTokens.find((t) => !countHit || t.pos > countHit.pos);
    if (countHit || !measures.length || st.having) {
      if (countHit && countTarget && !st.filterCols.has(countTarget.idx)) {
        const name = cols[countTarget.idx].name;
        select.push(`count(DISTINCT ${qi(name)}) AS ${qi(`distinct_${name}`)}`);
        measureCols.push(`distinct_${name}`);
        describe.unshift(`number of distinct ${name}`);
      } else {
        select.push('count(*) AS record_count');
        measureCols.push('record_count');
        describe.unshift('number of records');
      }
    }
    for (const m of measures) {
      const col = cols[m.idx];
      if (m.fn === 'distinct') {
        const alias = `distinct_${col.name}`;
        select.push(`count(DISTINCT ${qi(col.name)}) AS ${qi(alias)}`);
        measureCols.push(alias);
        describe.push(`number of distinct ${col.name}`);
        continue;
      }
      const alias = aggAlias(m.fn, col.name, m.q);
      select.push(`${aggSql(m.fn, col, m.q)} AS ${qi(alias)}`);
      measureCols.push(alias);
      describe.push(`${aggLabel(m.fn, m.q)} of ${col.name}`);
    }
    if (describe[0]?.startsWith('per ') || describe[0]?.startsWith('grouped')) {
      // put measures first in the description
      const measureDesc = describe.filter((d) => !d.startsWith('per ') && !d.startsWith('grouped'));
      const rest = describe.filter((d) => d.startsWith('per ') || d.startsWith('grouped'));
      describe.length = 0;
      describe.push(...measureDesc, ...rest);
    }
    recognized.push('aggregate');
  }

  if (mode === 'aggregate' || mode === 'summary' || mode === 'correlation') {
    const first = measureCols[0];
    if (st.sort) {
      const sc = cols[st.sort.idx];
      const sortAlias = measureCols.find((a) => a.endsWith(`_${sc.name}`)) ?? (groupBy.includes(qi(sc.name)) ? sc.name : null);
      if (sortAlias) orderBy.push(`${qi(sortAlias)} ${st.sort.dir}`);
    }
    if (st.having) {
      groupBy.length || notes.push('A count condition needs a grouping column (e.g. "machines with more than 10 errors").');
    }
    if (!orderBy.length) {
      if (st.whichTime || ((st.which || supDir || st.limit) && groupNames.length && first)) {
        orderBy.push(`${qi(first)} ${supDir === 'low' || /bottom|lowest|worst|smallest/.test(st.limitWord ?? '') ? 'ASC' : 'DESC'} NULLS LAST`);
        limit = st.limit ?? ((st.which && supDir) || st.whichTime ? 1 : null);
        if (limit) describe.push(limit === 1 ? (supDir === 'low' ? 'lowest only' : 'highest only') : `top ${limit}`);
      } else if (bucketAlias) {
        orderBy.push(qi(bucketAlias), ...groupNames.map(qi));
      } else if (groupNames.length && first) {
        orderBy.push(`${qi(first)} DESC NULLS LAST`);
      }
    }
    if (limit == null && st.limit && groupBy.length) limit = st.limit;

    const having = st.having && groupBy.length ? ` HAVING count(*) ${st.having.op} ${st.having.n}` : '';
    if (having) describe.push(`having ${st.having.op} ${st.having.n} records`);
    const sql = `SELECT ${select.join(', ')} FROM ${table}${where}${groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}${having}${orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : ''}${limit ? ` LIMIT ${limit}` : ''}`;

    if (bucketAlias && !st.whichTime) {
      chart = { type: 'line', x: bucketAlias, y: groupNames.length ? [first] : measureCols, series: groupNames[0] ?? null };
    } else if (groupNames.length || bucketAlias) {
      chart = { type: 'bar', x: groupNames[0] ?? bucketAlias, y: measureCols.slice(0, 3), labels: groupNames.length > 1 ? groupNames : undefined };
    } else {
      chart = { type: 'stat' };
    }
    return finish({ sql, mode, chart, measureCols });
  }

  if (mode === 'list' || mode === 'argmax' || mode === 'unknown') {
    // Explicit "show X and Y for ..." -> just those columns (+ time and filter columns); otherwise all.
    let chosen = null;
    if (intent.list && colTokens.length && !intent.recordNoun) {
      chosen = new Set([schema.timeColumn, ...colTokens.map((t) => cols[t.idx].name), ...[...st.filterCols].map((i) => cols[i].name)]);
    }
    const columnsSql = chosen ? cols.filter((c) => chosen.has(c.name)).map((c) => qi(c.name)).join(', ') : '*';
    const extra = st.geo ? `, round(${st.geo.distanceExpr}, 3) AS distance_km` : '';
    if (mode === 'argmax') {
      const m = metricTokens[0];
      orderBy.push(`${qi(cols[m.idx].name)} ${supDir === 'low' ? 'ASC' : 'DESC'} NULLS LAST`);
      limit = st.limit ?? 1;
      describe.push(`record${limit > 1 ? 's' : ''} with the ${supDir === 'low' ? 'lowest' : 'highest'} ${cols[m.idx].name}`);
      recognized.push('argmax');
    } else {
      if (st.sort) orderBy.push(`${qi(cols[st.sort.idx].name)} ${st.sort.dir}`);
      else if (st.geo?.nearest) orderBy.push('distance_km ASC');
      else if (metricTokens.length && supDir) orderBy.push(`${qi(cols[metricTokens[0].idx].name)} ${supDir === 'low' ? 'ASC' : 'DESC'} NULLS LAST`);
      else if (schema.timeColumn) orderBy.push(`${qi(schema.timeColumn)} ${/oldest|earliest|first/.test(lower) || /oldest|earliest|first/.test(st.limitWord ?? '') ? 'ASC' : 'DESC'}`);
      limit = st.limit ?? (st.geo?.nearest ? 10 : listLimit);
      describe.push(st.geo?.nearest ? `${limit} nearest records to (${st.geo.lat}, ${st.geo.lon})` : `records (${orderBy[0]?.includes('ASC') ? 'oldest' : 'latest'} first, up to ${limit})`);
      recognized.push('list');
      countSql = `SELECT count(*) AS total FROM ${table}${where}`;
    }
    const sql = `SELECT ${columnsSql}${extra} FROM ${table}${where}${orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : ''} LIMIT ${limit}`;
    chart = schema.latColumn && schema.lonColumn ? { type: 'map', lat: schema.latColumn, lon: schema.lonColumn, color: metricTokens[0] ? cols[metricTokens[0].idx].name : null } : { type: 'table' };
    return finish({ sql, mode, chart, measureCols: [], countSql });
  }

  function finish({ sql, mode: m, chart: ch, measureCols: mc, countSql: cs = null }) {
    // What wasn't understood?
    const leftover = st.text
      .replace(ANY_TOKEN, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !/^-?\d+(\.\d+)?(st|nd|rd|th)?$/.test(w) && !KNOWN_WORDS.has(w) && !KNOWN_WORDS.has(w.replace(/'s$|s$/, '')));
    const unknownWords = [...new Set(leftover)];
    const confidence = m === 'unknown' ? 'low' : unknownWords.length === 0 ? 'high' : unknownWords.length === 1 ? 'medium' : 'low';
    if (st.whereDesc.length) describe.push(`where ${st.whereDesc.join(' and ')}`);
    return {
      engine: 'rules',
      sql,
      countSql: cs,
      mode: m,
      chart: ch,
      measureCols: mc,
      confidence,
      unknownWords,
      interpretation: describe.join(' · '),
      notes,
      filters: st.whereDesc,
      whereParts: st.where.map((sql, i) => ({ sql, desc: st.whereDesc[i], kind: st.whereKinds[i] })),
      anchor: formatTs(anchor),
    };
  }
}
