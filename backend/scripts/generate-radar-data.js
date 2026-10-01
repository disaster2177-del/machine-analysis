// Simulate several radars observing air traffic and write ASTERIX CAT048-style plots
// into DuckDB (table radar_plots). Use it to try the app before pointing it at real data.
//
//   node scripts/generate-radar-data.js                    -> 1 day, 5 sensors (~1 crore plots)
//   node scripts/generate-radar-data.js --days 5           -> ~5 crore plots
//   node scripts/generate-radar-data.js --aircraft 150     -> lighter traffic
//
// It simulates real effects so every analysis has something to find: different scan periods,
// a sensor with weaker detection, a registration (azimuth) bias, an outage, emergencies,
// squawk changes, corrupted Mode C, clutter and ghost plots, line-of-sight coverage limits.
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, timestampValue } from '@duckdb/node-api';
import { config } from '../src/config.js';
import { RADAR_DDL, RADAR_FIELDS, RADAR_TABLE } from '../src/radar/fields.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const days = Number(arg('--days', 1));
const out = path.resolve(arg('--out', config.dbPath));
const startIso = arg('--start', '2026-09-30T00:00:00Z');
const concurrent = Number(arg('--aircraft', 260));
let seed = Number(arg('--seed', 42));

// ---- deterministic random numbers ----
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const START = Date.parse(startIso);
const END = START + days * 86400000;

// ---- sensors (SAC 25 = India area code used for this simulation) ----
const SENSORS = [
  { sic: 1, id: 'Mumbai', lat: 19.0896, lon: 72.8656, period: 4, ssr: 200, psr: 80, pd: 0.985, pdPsr: 0.93, rBias: 25, azBias: 0.02, rSig: 35, azSig: 0.045, lat0: 0.35 },
  { sic: 2, id: 'Pune', lat: 18.5821, lon: 73.9197, period: 4, ssr: 200, psr: 80, pd: 0.978, pdPsr: 0.9, rBias: -55, azBias: 0.04, rSig: 40, azSig: 0.05, lat0: 0.45 },
  { sic: 3, id: 'Ahmedabad', lat: 23.0772, lon: 72.6347, period: 5, ssr: 220, psr: 70, pd: 0.97, pdPsr: 0.88, rBias: 15, azBias: -0.06, rSig: 45, azSig: 0.06, lat0: 0.6 },
  { sic: 4, id: 'Nagpur', lat: 21.0922, lon: 79.0472, period: 10, ssr: 250, psr: 0, pd: 0.99, pdPsr: 0, rBias: 40, azBias: 0.22, rSig: 60, azSig: 0.07, lat0: 0.9 },
  { sic: 5, id: 'Hyderabad', lat: 17.2403, lon: 78.4294, period: 4, ssr: 200, psr: 80, pd: 0.925, pdPsr: 0.85, rBias: -20, azBias: -0.03, rSig: 50, azSig: 0.06, lat0: 1.8 },
];
const OUTAGES = {
  Hyderabad: [[6.2, 6.62]], // hours after start: 25 min outage
  Ahmedabad: [[3.0, 3.035], [11.7, 11.735], [19.25, 19.285]], // three ~2 min gaps
};
const inOutage = (s, t) => (OUTAGES[s.id] ?? []).some(([a, b]) => t >= START + a * 3600000 && t < START + b * 3600000);

// ---- airports & flights ----
const AIRPORTS = [
  [19.0896, 72.8656], [18.5821, 73.9197], [23.0772, 72.6347], [21.0922, 79.0472], [17.2403, 78.4294],
  [15.3808, 73.8314], [22.7217, 75.8011], [13.1986, 77.7066], [28.5562, 77.1], [21.1702, 72.8311],
  [26.8242, 75.8122], [16.5062, 80.6480], [20.7127, 70.9216], [12.9941, 80.1709], [19.8627, 75.3981],
];
const EDGE = () => (rand() < 0.5 ? [9 + rand() * 22, rand() < 0.5 ? 66 : 86] : [rand() < 0.5 ? 9 : 31, 66 + rand() * 20]);
const AIRLINES = ['AIC', 'IGO', 'SEJ', 'VTI', 'AKJ', 'AXB', 'UAE', 'QTR', 'SIA', 'BAW', 'DLH'];
const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

const usedAddr = new Set();
function newAddress() {
  let a;
  do a = Math.floor(rand() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  while (usedAddr.has(a));
  usedAddr.add(a);
  return a;
}
const octal4 = () => Array.from({ length: 4 }, () => Math.floor(rand() * 8)).join('');
function normalCode() {
  let c;
  do c = octal4();
  while (['7500', '7600', '7700', '7000', '2000', '1200'].includes(c));
  return c;
}

const avgDurH = 1.4;
const nFlights = Math.round((concurrent * (days * 24 + 3)) / avgDurH);
const flights = [];
for (let i = 0; i < nFlights; i++) {
  // fewer departures at night (UTC+5:30 local)
  let dep;
  do dep = START - 3 * 3600000 + rand() * (END - START + 3 * 3600000);
  while (rand() > 0.35 + 0.65 * Math.sin(Math.PI * ((((dep / 3600000 + 5.5) % 24) + 24) % 24) / 24) ** 2);
  const psrOnly = rand() < 0.03;
  let a, b;
  if (psrOnly) {
    a = pick(AIRPORTS);
    const ang = rand() * 2 * Math.PI;
    b = [a[0] + Math.cos(ang) * 0.6, a[1] + Math.sin(ang) * 0.6];
  } else {
    a = rand() < 0.25 ? EDGE() : pick(AIRPORTS);
    do b = rand() < 0.25 ? EDGE() : pick(AIRPORTS);
    while (b === a);
  }
  const dE = (b[1] - a[1]) * kmPerDegLon((a[0] + b[0]) / 2);
  const dN = (b[0] - a[0]) * KM_PER_DEG_LAT;
  const distKm = Math.hypot(dE, dN);
  if (distKm < 30) continue;
  const speedKt = psrOnly ? 110 + rand() * 60 : 380 + rand() * 110;
  const durMs = (distKm / (speedKt * 1.852)) * 3600000;
  const cruise = psrOnly ? 20 + rand() * 40 : Math.min(410, Math.max(150, Math.round(distKm / 3.5 / 10) * 10 + 150 + rand() * 60));
  const f = {
    a, b, dep, arr: dep + durMs, speedKt, cruise,
    startsLow: !psrOnly && AIRPORTS.includes(a), endsLow: AIRPORTS.includes(b),
    headingDeg: ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360,
    psrOnly, modeS: !psrOnly && rand() < 0.85,
    address: psrOnly ? null : newAddress(),
    callsign: psrOnly ? null : `${pick(AIRLINES)}${Math.floor(10 + rand() * 9000)}`,
    code: psrOnly ? null : normalCode(),
    codeChange: !psrOnly && rand() < 0.1 ? { at: 0.2 + rand() * 0.6, code: normalCode() } : null,
    emergency: null,
  };
  flights.push(f);
}
// A few emergencies
const em = flights.filter((f) => !f.psrOnly && f.dep > START && f.arr < END).slice(0, 400);
[['7700', 0.55], ['7700', 0.4], ['7600', 0.5], ['7500', 0.7]].forEach(([code, at], i) => {
  if (em[i * 97]) em[i * 97].emergency = { code, at };
});
flights.sort((x, y) => x.dep - y.dep);

function state(f, t) {
  const p = (t - f.dep) / (f.arr - f.dep);
  const lat = f.a[0] + (f.b[0] - f.a[0]) * p;
  const lon = f.a[1] + (f.b[1] - f.a[1]) * p;
  const minsFromStart = (t - f.dep) / 60000;
  const minsToEnd = (f.arr - t) / 60000;
  let fl = f.cruise;
  let climb = 'MAINTAINING';
  if (f.startsLow && minsFromStart * 22 < fl) {
    fl = minsFromStart * 22;
    climb = 'CLIMBING';
  }
  if (f.endsLow && minsToEnd * 20 < fl) {
    fl = minsToEnd * 20;
    climb = 'DESCENDING';
  }
  fl = Math.max(fl, f.psrOnly ? 10 : 15);
  const speed = f.speedKt * (fl < 100 ? 0.65 + fl / 300 : 1);
  let code = f.code;
  if (f.codeChange && p >= f.codeChange.at) code = f.codeChange.code;
  if (f.emergency && p >= f.emergency.at) code = f.emergency.code;
  return { lat, lon, fl, climb, speed, code };
}

// ---- output ----
fs.mkdirSync(path.dirname(out), { recursive: true });
for (const f of [out, `${out}.wal`, `${out}.meta.json`]) fs.rmSync(f, { force: true });
const db = await DuckDBInstance.create(out);
const con = await db.connect();
await con.run(RADAR_DDL);
const appender = await con.createAppender(RADAR_TABLE);
const TYPES = Object.fromEntries(RADAR_FIELDS.map((f) => [f.name, f.type]));
const COLS = RADAR_FIELDS.map((f) => f.name);

function append(row) {
  for (const c of COLS) {
    const v = row[c];
    if (v === null || v === undefined) appender.appendNull();
    else if (TYPES[c] === 'TIMESTAMP') appender.appendTimestamp(timestampValue(BigInt(Math.round(v * 1000))));
    else if (TYPES[c] === 'DOUBLE') appender.appendDouble(v);
    else if (TYPES[c] === 'INTEGER') appender.appendInteger(v);
    else if (TYPES[c] === 'SMALLINT') appender.appendSmallInt(v);
    else if (TYPES[c] === 'BOOLEAN') appender.appendBoolean(v);
    else appender.appendVarchar(String(v));
  }
  appender.endRow();
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const sensorState = SENSORS.map((s) => ({ s, next: START + rand() * s.period * 1000, idx: 0, active: [], tracks: new Map(), trackSeq: 1 }));

function inCoverage(s, f, st) {
  const e = (st.lon - s.lon) * kmPerDegLon(s.lat);
  const n = (st.lat - s.lat) * KM_PER_DEG_LAT;
  const groundKm = Math.hypot(e, n);
  const hKm = st.fl * 0.03048;
  const slantNm = Math.hypot(groundKm, hKm) / 1.852;
  const horizonNm = 1.23 * Math.sqrt(st.fl * 100) + 5; // radio line of sight
  const maxNm = f.psrOnly ? s.psr : s.ssr;
  return { e, n, groundKm, hKm, slantNm, ok: slantNm <= maxNm && slantNm <= horizonNm && slantNm > 0.5 };
}

const WINDOW = 10 * 60 * 1000;
let total = 0;
const t0 = Date.now();
for (let w = START; w < END; w += WINDOW) {
  const rows = [];
  for (const ss of sensorState) {
    const { s } = ss;
    for (; ss.next < Math.min(w + WINDOW, END); ss.next += s.period * 1000) {
      const scanStart = ss.next;
      while (ss.idx < flights.length && flights[ss.idx].dep <= scanStart + s.period * 1000) ss.active.push(flights[ss.idx++]);
      ss.active = ss.active.filter((f) => f.arr > scanStart);
      if (inOutage(s, scanStart)) continue;

      // clutter: unassociated primary plots near the sensor
      if (s.psr && rand() < 0.35) {
        const rng = 2 + rand() * 18;
        const az = rand() * 360;
        const t = scanStart + (az / 360) * s.period * 1000;
        const e = rng * 1.852 * Math.sin((az * Math.PI) / 180);
        const n = rng * 1.852 * Math.cos((az * Math.PI) / 180);
        rows.push({
          ts: t, received_at: t + s.lat0 * 1000, sac: 25, sic: s.sic, sensor_id: s.id, report_type: 'PSR', simulated: false, spi: false,
          range_nm: r3(rng), azimuth_deg: r3(az), psr_amplitude_dbm: r3(-85 + rand() * 10), x_nm: r3(e / 1.852), y_nm: r3(n / 1.852),
          lat: s.lat + n / KM_PER_DEG_LAT, lon: s.lon + e / kmPerDegLon(s.lat), ghost: false, track_end: false,
        });
      }

      for (const f of ss.active) {
        if (f.dep > scanStart) continue;
        if (f.psrOnly && !s.psr) continue;
        let st = state(f, scanStart);
        let geo = inCoverage(s, f, st);
        if (!geo.ok) continue;
        const azTrue0 = ((Math.atan2(geo.e, geo.n) * 180) / Math.PI + 360) % 360;
        const t = scanStart + (azTrue0 / 360) * s.period * 1000;
        if (t >= f.arr) continue;
        st = state(f, t);
        geo = inCoverage(s, f, st);
        if (!geo.ok) continue;

        const key = f;
        let trk = ss.tracks.get(key);
        const ssrDet = !f.psrOnly && rand() < s.pd;
        const psrDet = s.psr && geo.slantNm <= s.psr && rand() < (f.psrOnly ? s.pdPsr * 0.97 : s.pdPsr);
        if (!ssrDet && !(psrDet && (f.psrOnly || rand() < 0.5))) {
          continue; // missed this scan
        }
        if (!trk || t - trk.last > config.radar.trackGapS * 1000) {
          trk = { no: ss.trackSeq, count: 0, last: t };
          ss.trackSeq = (ss.trackSeq % 4095) + 1;
          ss.tracks.set(key, trk);
        }
        trk.count++;
        trk.last = t;

        // measured polar position with sensor bias + noise
        const azTrue = ((Math.atan2(geo.e, geo.n) * 180) / Math.PI + 360) % 360;
        const rhoNm = geo.slantNm + (s.rBias + gauss() * s.rSig) / 1852;
        const theta = (azTrue + s.azBias + gauss() * s.azSig + 360) % 360;
        const groundNm = Math.sqrt(Math.max(0, rhoNm ** 2 - (geo.hKm / 1.852) ** 2));
        const x = groundNm * Math.sin((theta * Math.PI) / 180);
        const y = groundNm * Math.cos((theta * Math.PI) / 180);
        const lat = s.lat + (y * 1.852) / KM_PER_DEG_LAT;
        const lon = s.lon + (x * 1.852) / kmPerDegLon(s.lat);

        // track end: will the target be out of coverage (or landed) at the next scan?
        const tn = t + s.period * 1000;
        const ends = tn >= f.arr || !inCoverage(s, f, state(f, tn)).ok;
        if (ends) ss.tracks.delete(key);

        let fl = f.psrOnly ? null : Math.round(st.fl * 4) / 4;
        if (fl !== null && rand() < 0.0004) fl = Math.min(600, Math.max(0, fl + (rand() < 0.5 ? -1 : 1) * (100 + Math.round(rand() * 200)))); // corrupted Mode C
        const garbled = !f.psrOnly && rand() < 0.003;
        let code = st.code;
        if (garbled) code = code.slice(0, 3) + Math.floor(rand() * 8);
        const reportType = f.psrOnly
          ? 'PSR'
          : f.modeS
            ? `${trk.count === 1 ? 'MODES_ALLCALL' : 'MODES_ROLLCALL'}${psrDet ? '+PSR' : ''}`
            : psrDet ? 'SSR+PSR' : 'SSR';
        const row = {
          ts: t,
          received_at: t + (s.lat0 + Math.abs(gauss()) * 0.15) * 1000,
          sac: 25, sic: s.sic, sensor_id: s.id, report_type: reportType, simulated: false, spi: !f.psrOnly && rand() < 0.002,
          range_nm: r3(rhoNm), azimuth_deg: r3(theta),
          mode3a: code, mode3a_valid: code ? !garbled : null, mode3a_garbled: code ? garbled : null,
          flight_level: fl, fl_valid: fl === null ? null : true,
          ssr_replies: f.psrOnly ? null : 4 + Math.floor(rand() * 9),
          ssr_amplitude_dbm: f.psrOnly ? null : r3(-48 - 20 * Math.log10(Math.max(rhoNm, 5) / 10) + gauss() * 2),
          psr_amplitude_dbm: psrDet ? r3(-60 - 40 * Math.log10(Math.max(rhoNm, 5) / 10) + gauss() * 3) : null,
          aircraft_address: f.modeS ? f.address : null,
          callsign: f.modeS ? f.callsign : null,
          track_number: trk.no,
          x_nm: r3(x), y_nm: r3(y),
          ground_speed_kt: r3(st.speed + gauss() * 3),
          heading_deg: r3((f.headingDeg + gauss() * 0.8 + 360) % 360),
          track_status: trk.count <= 2 ? 'TENTATIVE' : 'CONFIRMED',
          climb_mode: f.psrOnly ? 'UNKNOWN' : st.climb,
          track_end: ends, ghost: false,
          lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        };
        rows.push(row);
        // occasional SSR reflection ghost: same target, mirrored azimuth
        if (!f.psrOnly && rand() < 0.0015) {
          const gaz = (theta + 60 + rand() * 60) % 360;
          const gx = groundNm * Math.sin((gaz * Math.PI) / 180);
          const gy = groundNm * Math.cos((gaz * Math.PI) / 180);
          rows.push({
            ...row, azimuth_deg: r3(gaz), x_nm: r3(gx), y_nm: r3(gy), ghost: true, track_number: 4000 + Math.floor(rand() * 95),
            track_status: 'TENTATIVE', track_end: true,
            lat: Math.round((s.lat + (gy * 1.852) / KM_PER_DEG_LAT) * 1e6) / 1e6, lon: Math.round((s.lon + (gx * 1.852) / kmPerDegLon(s.lat)) * 1e6) / 1e6,
          });
        }
      }
    }
  }
  rows.sort((p, q) => p.ts - q.ts);
  for (const r of rows) {
    if (r.ts < END) append(r);
  }
  total += rows.length;
  appender.flushSync();
  const pct = ((w + WINDOW - START) / (END - START)) * 100;
  if (Math.round(pct) % 10 === 0) process.stdout.write(`\r${Math.min(100, pct).toFixed(0)}%  ${total.toLocaleString('en-IN')} plots`);
}
appender.closeSync();
await con.run('CHECKPOINT');
const n = (await con.runAndReadAll(`SELECT count(*) AS n, count(DISTINCT sensor_id) AS s FROM ${RADAR_TABLE}`)).getRowObjectsJson()[0];
console.log(`\nDone: ${n.n} plots from ${n.s} sensors, ${days} day(s), in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
