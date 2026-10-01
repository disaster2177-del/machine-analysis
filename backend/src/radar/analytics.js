// Radar surveillance analyses on ASTERIX CAT048-style plots stored in DuckDB.
//
// Each analysis is triggered by words in the question. Time/sensor/aircraft filters still come
// from the general rule parser ("for Mumbai last 6 hours"), so analyses compose with any filter.
// Unless a period is given, analyses cover the last RADAR_DEFAULT_WINDOW_H hours of data so they
// stay fast on crores of plots; say "all time" to analyse everything.

import { config } from '../config.js';
import { qi } from '../nlq/sql.js';
import { fmt } from '../nlq/narrate.js';
import { EMERGENCY_CODES } from './fields.js';

const ms = (a, b) => `date_diff('millisecond', ${a}, ${b})`;

function durationSeconds(text, fallback) {
  const m = text.match(/(?:longer|more|greater|over|above|exceed\w*|at\s+least|>)\s*(?:than\s+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return u.startsWith('h') ? n * 3600 : u.startsWith('m') ? n * 60 : n;
}

const ANALYSES = [
  {
    id: 'emergency',
    title: 'Emergency squawks (7500 / 7600 / 7700)',
    match: /emergenc|\b7[567]00\b|hijack|radio\s+fail|mayday|distress|unlawful/i,
    needs: ['mode3a'],
    build: (ctx) => {
      const { t, where, has } = ctx;
      const garbled = has('mode3a_garbled') ? ' AND coalesce(mode3a_garbled, false) = false' : '';
      return {
        sql: `SELECT mode3a AS squawk, CASE mode3a WHEN '7500' THEN 'hijack' WHEN '7600' THEN 'radio failure' ELSE 'general emergency' END AS meaning,
  ${has('aircraft_address') ? 'aircraft_address' : 'NULL AS aircraft_address'}, ${has('callsign') ? 'any_value(callsign) AS callsign' : 'NULL AS callsign'},
  min(ts) AS first_seen, max(ts) AS last_seen, count(*) AS plots, string_agg(DISTINCT sensor_id, ', ') AS sensors,
  ${has('lat') ? 'arg_max(lat, ts) AS last_lat, arg_max(lon, ts) AS last_lon,' : ''} ${has('flight_level') ? 'arg_max(flight_level, ts) AS last_fl' : 'NULL AS last_fl'}
FROM ${t} WHERE ${where} AND mode3a IN ('7500', '7600', '7700')${garbled}
GROUP BY mode3a${has('aircraft_address') ? ', aircraft_address' : ''} ORDER BY first_seen DESC LIMIT 500`,
        chart: { type: 'table' },
        narrate: (rows) =>
          rows.length
            ? `**${rows.length} emergency squawk event${rows.length > 1 ? 's' : ''}**: ${rows
                .slice(0, 4)
                .map((r) => `${r.squawk} (${EMERGENCY_CODES[r.squawk]}) by ${r.callsign ?? r.aircraft_address ?? 'unknown'} from ${fmt(r.first_seen)}, seen by ${r.sensors}`)
                .join('; ')}${rows.length > 4 ? '; …' : ''}.`
            : 'No emergency squawks (7500/7600/7700) in this period.',
      };
    },
  },
  {
    id: 'pd',
    title: 'Probability of detection',
    match: /probability\s+of\s+detection|detection\s+(?:probability|rate|ratio)|\bpd\b|missed\s+(?:detections?|plots?|scans?|updates?)|miss\s+rate/i,
    needs: ['track_number'],
    build: (ctx) => {
      const { t, where, has } = ctx;
      const G = config.radar.trackGapS;
      return {
        sql: `WITH base AS (
  SELECT sensor_id, track_number, ts FROM ${t}
  WHERE ${where} AND track_number IS NOT NULL${has('ghost') ? ' AND NOT coalesce(ghost, false)' : ''}
), d AS (
  SELECT *, ${ms('lag(ts) OVER w', 'ts')} / 1000.0 AS dt FROM base WINDOW w AS (PARTITION BY sensor_id, track_number ORDER BY ts)
), seg AS (
  SELECT *, sum(CASE WHEN dt IS NULL OR dt > ${G} THEN 1 ELSE 0 END) OVER (PARTITION BY sensor_id, track_number ORDER BY ts) AS seg FROM d
), scan AS (
  SELECT sensor_id, median(dt) AS period FROM d WHERE dt > 0.5 AND dt <= ${G} GROUP BY 1
), trk AS (
  SELECT sensor_id, track_number, seg, count(*) AS n, ${ms('min(ts)', 'max(ts)')} / 1000.0 AS dur FROM seg GROUP BY ALL HAVING count(*) >= 3
)
SELECT sensor_id,
  round(100.0 * sum(least(n, round(dur / period) + 1)) / sum(round(dur / period) + 1), 2) AS pd_percent,
  count(*) AS tracks, sum(n) AS plots,
  CAST(sum(greatest(0, round(dur / period) + 1 - n)) AS BIGINT) AS missed_updates,
  round(any_value(period), 2) AS scan_period_s
FROM trk JOIN scan USING (sensor_id) GROUP BY sensor_id ORDER BY pd_percent`,
        chart: { type: 'bar', x: 'sensor_id', y: ['pd_percent'] },
        narrate: (rows) => {
          if (!rows.length) return 'Not enough track data to estimate probability of detection.';
          const target = config.radar.pdTarget;
          const below = rows.filter((r) => r.pd_percent < target);
          const best = rows.at(-1);
          return `Lowest probability of detection: **${rows[0].sensor_id} ${fmt(rows[0].pd_percent)}%** (${fmt(rows[0].missed_updates)} missed updates); highest: ${best.sensor_id} ${fmt(best.pd_percent)}%. ${
            below.length ? `**${below.length} sensor${below.length > 1 ? 's' : ''} below the ${target}% target:** ${below.map((r) => r.sensor_id).join(', ')}.` : `All sensors meet the ${target}% target.`
          }`;
        },
        notes: [`Pd is estimated from tracks: expected updates = track duration ÷ scan period + 1; tracks silent for more than ${G}s are split. Target ${config.radar.pdTarget}% (PD_TARGET).`],
      };
    },
  },
  {
    id: 'scan',
    title: 'Scan period / update rate',
    match: /scan\s+(?:period|rate|time|interval)|rotation|revisit|update\s+(?:rate|interval|period|time)|antenna\s+(?:speed|period|rpm)|\brpm\b/i,
    needs: ['track_number'],
    build: ({ t, where }) => ({
      sql: `WITH d AS (
  SELECT sensor_id, ${ms('lag(ts) OVER (PARTITION BY sensor_id, track_number ORDER BY ts)', 'ts')} / 1000.0 AS dt
  FROM ${t} WHERE ${where} AND track_number IS NOT NULL
)
SELECT sensor_id, round(median(dt), 2) AS scan_period_s, round(60 / median(dt), 1) AS rpm,
  round(quantile_cont(dt, 0.05), 2) AS p5_update_s, round(quantile_cont(dt, 0.95), 2) AS p95_update_s, count(*) AS updates
FROM d WHERE dt > 0.5 AND dt <= ${config.radar.trackGapS} GROUP BY 1 ORDER BY scan_period_s`,
      chart: { type: 'bar', x: 'sensor_id', y: ['scan_period_s'] },
      narrate: (rows) =>
        rows.length
          ? `Scan periods: ${rows.map((r) => `**${r.sensor_id} ${fmt(r.scan_period_s)} s** (${fmt(r.rpm)} rpm)`).join(', ')}.`
          : 'No track updates found to measure scan period.',
    }),
  },
  {
    id: 'gaps',
    title: 'Data gaps / sensor outages',
    match: /\bgaps?\b|outages?|down\s*time|went\s+(?:down|silent|offline|quiet)|stopped\s+(?:sending|reporting)|no\s+data|silen(?:t|ce)|data\s+loss|interruptions?|blackouts?/i,
    needs: [],
    build: ({ t, where, question }) => {
      const thr = durationSeconds(question, 30);
      return {
        sql: `WITH s AS (SELECT sensor_id, ts, lag(ts) OVER (PARTITION BY sensor_id ORDER BY ts) AS prev FROM ${t} WHERE ${where})
SELECT sensor_id, prev AS gap_start, ts AS gap_end, round(${ms('prev', 'ts')} / 1000.0, 1) AS gap_s
FROM s WHERE prev IS NOT NULL AND ${ms('prev', 'ts')} > ${thr * 1000} ORDER BY gap_s DESC LIMIT 500`,
        chart: { type: 'table' },
        interpretation: `periods with no plots for more than ${thr}s`,
        narrate: (rows) => {
          if (!rows.length) return `No data gaps longer than ${thr} s.`;
          const per = {};
          for (const r of rows) per[r.sensor_id] = (per[r.sensor_id] ?? 0) + r.gap_s;
          const top = rows[0];
          return `**${rows.length} gap${rows.length > 1 ? 's' : ''} longer than ${thr} s.** Longest: **${top.sensor_id}** silent for **${fmt(top.gap_s / 60)} min** from ${fmt(top.gap_start)}. Total silent time: ${Object.entries(per)
            .map(([s, v]) => `${s} ${fmt(v / 60)} min`)
            .join(', ')}.`;
        },
      };
    },
  },
  {
    id: 'status',
    title: 'Sensor status',
    match: /last\s+(?:seen|report(?:ed)?|update|data|plot)|sensor\s+(?:status|health)|\bhealth\b|alive|online|offline|up\s+and\s+running|which\s+sensors?\s+(?:are|is)\s+(?:working|active|down|reporting)|active\s+sensors|sensors?\s+(?:working|reporting)/i,
    needs: [],
    defaultWindowH: 24,
    build: ({ t, where, anchor, has }) => ({
      sql: `SELECT sensor_id, ${has('sac') ? 'any_value(sac) AS sac, any_value(sic) AS sic,' : ''} max(ts) AS last_report,
  round(${ms('max(ts)', `TIMESTAMP '${anchor}'`)} / 1000.0, 1) AS seconds_since_last,
  count(*) FILTER (WHERE ts > TIMESTAMP '${anchor}' - INTERVAL 5 MINUTE) AS plots_last_5_min,
  CASE WHEN ${ms('max(ts)', `TIMESTAMP '${anchor}'`)} > 60000 THEN 'SILENT' ELSE 'ACTIVE' END AS status
FROM ${t} WHERE ${where} GROUP BY sensor_id ORDER BY sensor_id`,
      chart: { type: 'table' },
      narrate: (rows) => {
        const silent = rows.filter((r) => r.status === 'SILENT');
        return `${rows.length - silent.length} of ${rows.length} sensors active at ${fmt(anchor)}.${
          silent.length ? ` **Silent:** ${silent.map((r) => `${r.sensor_id} (last plot ${fmt(r.last_report)})`).join(', ')}.` : ''
        }`;
      },
    }),
  },
  {
    id: 'bias',
    title: 'Cross-sensor registration bias',
    match: /\bbias(?:es)?\b|registration|alignment|mis-?align|cross[\s-]*sensor|between\s+(?:the\s+)?(?:sensors|radars)|sensors?\s+(?:comparison|disagree\w*)|position\s+(?:difference|error|offset)|offset\s+between/i,
    needs: ['aircraft_address', 'lat', 'lon', 'x_nm', 'y_nm', 'ground_speed_kt', 'heading_deg'],
    build: ({ t, where, has }) => ({
      sql: `WITH p AS (
  SELECT sensor_id, aircraft_address, ts, lat, lon, x_nm, y_nm, azimuth_deg, flight_level, ground_speed_kt, heading_deg,
    CAST(floor(epoch_ms(ts) / 2000) AS BIGINT) AS bucket
  FROM ${t} WHERE ${where} AND aircraft_address IS NOT NULL AND lat IS NOT NULL${has('ghost') ? ' AND NOT coalesce(ghost, false)' : ''}
), m AS (
  SELECT a.sensor_id AS sensor_a, b.sensor_id AS sensor_b, a.azimuth_deg AS az_a, a.x_nm AS xa, a.y_nm AS ya, a.lat AS lat_a,
    -- sensor A's site, recovered from its own plot
    a.lat - a.y_nm * 1852 / 110574 AS site_lat, a.lon - a.x_nm * 1852 / (111320 * cos(radians(a.lat))) AS site_lon,
    -- B's plot moved to A's detection time using B's velocity
    b.lat + coalesce(b.ground_speed_kt, 0) * 0.514444 * (${ms('b.ts', 'a.ts')} / 1000.0) * cos(radians(b.heading_deg)) / 110574 AS lat_b,
    b.lon + coalesce(b.ground_speed_kt, 0) * 0.514444 * (${ms('b.ts', 'a.ts')} / 1000.0) * sin(radians(b.heading_deg)) / (111320 * cos(radians(b.lat))) AS lon_b,
    a.flight_level - b.flight_level AS fl_diff
  FROM p a JOIN p b ON a.aircraft_address = b.aircraft_address AND a.bucket = b.bucket AND a.sensor_id <> b.sensor_id
  WHERE abs(${ms('b.ts', 'a.ts')}) <= 2000
), polar AS (
  SELECT sensor_a, sensor_b, az_a, sqrt(xa * xa + ya * ya) * 1852 AS rng_a, fl_diff,
    (lon_b - site_lon) * 111320 * cos(radians(lat_a)) AS eb, (lat_b - site_lat) * 110574 AS nb
  FROM m
)
SELECT sensor_a, sensor_b, count(*) AS matched_plots,
  round(avg(((az_a - degrees(atan2(eb, nb)) + 540) % 360) - 180), 3) AS azimuth_bias_deg,
  round(avg(rng_a - sqrt(eb * eb + nb * nb)), 1) AS range_bias_m,
  round(sqrt(avg(power(rng_a * radians(((az_a - degrees(atan2(eb, nb)) + 540) % 360) - 180), 2) + power(rng_a - sqrt(eb * eb + nb * nb), 2))), 1) AS rms_position_diff_m,
  round(avg(fl_diff), 2) AS mean_fl_diff
FROM polar GROUP BY sensor_a, sensor_b HAVING count(*) >= 20 ORDER BY abs(azimuth_bias_deg) DESC`,
      chart: { type: 'bar', x: 'pair', y: ['azimuth_bias_deg'] },
      postprocess: (rows) => rows.map((r) => ({ pair: `${r.sensor_a} vs ${r.sensor_b}`, ...r })),
      narrate: (rows) => {
        if (!rows.length) return 'No aircraft were seen by two sensors at the same time in this period, so bias cannot be estimated.';
        const top = rows[0];
        // The misaligned sensor shows a large bias against every sensor it overlaps with.
        const per = {};
        for (const r of rows) {
          for (const s of [r.sensor_a, r.sensor_b]) (per[s] ??= []).push(Math.abs(r.azimuth_bias_deg));
        }
        const score = Object.entries(per).map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => b[1] - a[1]);
        const suspect = score.length > 2 && score[0][1] > 1.5 * score[1][1] ? ` **${score[0][0]} is the likely misaligned sensor** (average |azimuth bias| ${fmt(score[0][1])}° against its neighbours vs ${fmt(score[1][1])}° for the next).` : '';
        return `Largest relative registration error: **${top.sensor_a} vs ${top.sensor_b}: azimuth ${fmt(top.azimuth_bias_deg)}°, range ${fmt(top.range_bias_m)} m** (${fmt(top.matched_plots)} matched plots).${suspect} ${rows.length} sensor pairs compared.`;
      },
      notes: ['Bias is relative: the same Mode S aircraft seen by two sensors within 2 s, with the second plot moved to the first plot\'s time using its speed and heading, then compared in the first sensor\'s range/azimuth.'],
    }),
  },
  {
    id: 'codechange',
    title: 'Mode 3/A code changes',
    match: /(?:squawk|code|mode\s*3\s*\/?\s*a)\s+(?:changes?|switch\w*|swap\w*)|changed\s+(?:their\s+|its\s+|the\s+)?(?:squawk|code)/i,
    needs: ['mode3a', 'aircraft_address'],
    build: ({ t, where, has }) => ({
      sql: `WITH s AS (
  SELECT aircraft_address, callsign, sensor_id, ts, mode3a, lag(mode3a) OVER (PARTITION BY aircraft_address, sensor_id ORDER BY ts) AS prev
  FROM ${t} WHERE ${where} AND aircraft_address IS NOT NULL AND mode3a IS NOT NULL${has('mode3a_garbled') ? ' AND coalesce(mode3a_garbled, false) = false' : ''}
)
SELECT aircraft_address, any_value(callsign) AS callsign, prev AS old_code, mode3a AS new_code, min(ts) AS changed_at, string_agg(DISTINCT sensor_id, ', ') AS seen_by
FROM s WHERE prev IS NOT NULL AND prev <> mode3a GROUP BY aircraft_address, prev, mode3a ORDER BY changed_at DESC LIMIT 1000`,
      chart: { type: 'table' },
      narrate: (rows) =>
        rows.length
          ? `**${rows.length} code change${rows.length > 1 ? 's' : ''}** (${new Set(rows.map((r) => r.aircraft_address)).size} aircraft). Latest: ${rows[0].callsign ?? rows[0].aircraft_address} ${rows[0].old_code} → ${rows[0].new_code} at ${fmt(rows[0].changed_at)}.`
          : 'No Mode 3/A code changes in this period.',
    }),
  },
  {
    id: 'altjump',
    title: 'Implausible altitude (Mode C) jumps',
    match: /(?:altitude|level|\bfl\b|mode\s*c|height)\s+(?:jumps?|spikes?|bust|errors?|glitch\w*|corrupt\w*|anomal\w*)|implausible\s+(?:altitude|level)|jumps?\s+in\s+(?:altitude|fl|level)/i,
    needs: ['flight_level'],
    build: ({ t, where, question, has }) => {
      const rate = Number(question.match(/(\d{3,6})\s*(?:ft|feet)\s*(?:\/|per)\s*min/i)?.[1] ?? 8000);
      const key = has('aircraft_address') ? `coalesce(aircraft_address, CAST(track_number AS VARCHAR))` : 'track_number';
      return {
        sql: `WITH s AS (
  SELECT sensor_id, ${has('aircraft_address') ? 'aircraft_address, callsign,' : ''} track_number, ts, flight_level,
    lag(flight_level) OVER w AS prev_fl, lag(ts) OVER w AS prev_ts, lead(flight_level) OVER w AS next_fl
  FROM ${t} WHERE ${where} AND flight_level IS NOT NULL${has('fl_valid') ? ' AND coalesce(fl_valid, true)' : ''}
  WINDOW w AS (PARTITION BY sensor_id, ${key} ORDER BY ts)
)
SELECT ts, sensor_id, ${has('aircraft_address') ? 'aircraft_address, callsign,' : ''} track_number, prev_fl, flight_level, next_fl,
  round((flight_level - prev_fl) * 100 / (${ms('prev_ts', 'ts')} / 60000.0)) AS rate_ft_per_min
FROM s WHERE prev_ts IS NOT NULL AND ${ms('prev_ts', 'ts')} BETWEEN 1 AND 30000 AND abs(flight_level - prev_fl) >= 5
  AND abs((flight_level - prev_fl) * 100 / (${ms('prev_ts', 'ts')} / 60000.0)) > ${rate}
ORDER BY abs(rate_ft_per_min) DESC LIMIT 1000`,
        chart: { type: 'table' },
        interpretation: `flight level changes faster than ${rate} ft/min between consecutive updates`,
        narrate: (rows) =>
          rows.length
            ? `**${rows.length} implausible altitude jump${rows.length > 1 ? 's' : ''}** (faster than ${rate} ft/min). By sensor: ${Object.entries(
                rows.reduce((a, r) => ({ ...a, [r.sensor_id]: (a[r.sensor_id] ?? 0) + 1 }), {}),
              )
                .map(([s, n]) => `${s} ${n}`)
                .join(', ')}.`
            : `No altitude jumps faster than ${rate} ft/min.`,
      };
    },
  },
  {
    id: 'coverage',
    title: 'Coverage by azimuth',
    match: /coverage|(?:max(?:imum)?\s+)?range\s+(?:by|per)\s+azimuth|azimuth\s+sectors?|blind\s+(?:spots?|sectors?)|detection\s+range/i,
    needs: [],
    build: ({ t, where, question, has }) => {
      const S = Number(question.match(/(\d{1,2})\s*(?:°|deg(?:ree)?s?)\s*(?:sectors?|bins?)?/i)?.[1] ?? 10);
      return {
        sql: `SELECT sensor_id, floor(azimuth_deg / ${S}) * ${S} + ${S / 2} AS sector_deg, round(max(range_nm), 1) AS max_range_nm,
  round(quantile_cont(range_nm, 0.95), 1) AS p95_range_nm, count(*) AS plots
FROM ${t} WHERE ${where}${has('ghost') ? ' AND NOT coalesce(ghost, false)' : ''} GROUP BY ALL ORDER BY sensor_id, sector_deg`,
        chart: { type: 'polar', angle: 'sector_deg', radius: 'p95_range_nm', series: 'sensor_id' },
        interpretation: `${S}° azimuth sectors`,
        narrate: (rows) => {
          if (!rows.length) return 'No plots in this period.';
          const per = {};
          for (const r of rows) (per[r.sensor_id] ??= []).push(r);
          return Object.entries(per)
            .map(([s, rs]) => {
              const lo = rs.reduce((a, b) => (b.p95_range_nm < a.p95_range_nm ? b : a));
              const hi = rs.reduce((a, b) => (b.max_range_nm > a.max_range_nm ? b : a));
              return `**${s}**: farthest ${fmt(hi.max_range_nm)} NM (azimuth ${fmt(hi.sector_deg)}°), weakest sector ${fmt(lo.sector_deg)}° (95% of plots within ${fmt(lo.p95_range_nm)} NM)`;
            })
            .join('; ');
        },
      };
    },
  },
  {
    id: 'tracks',
    title: 'Track statistics',
    match: /track\s+(?:duration|length|continuity|statistic\w*|stats|life\w*|quality|drops?|breaks?|count)|tracks?\s+(?:dropped|lost|broken)|how\s+long\s+.*tracks?|short\s+tracks|dropped\s+tracks|number\s+of\s+tracks|track\s+statistics/i,
    needs: ['track_number'],
    build: ({ t, where, has }) => {
      const G = config.radar.trackGapS;
      return {
        sql: `WITH base AS (
  SELECT sensor_id, track_number, ts${has('track_end') ? ', track_end' : ', false AS track_end'} FROM ${t}
  WHERE ${where} AND track_number IS NOT NULL${has('ghost') ? ' AND NOT coalesce(ghost, false)' : ''}
), d AS (
  SELECT *, ${ms('lag(ts) OVER w', 'ts')} / 1000.0 AS dt FROM base WINDOW w AS (PARTITION BY sensor_id, track_number ORDER BY ts)
), seg AS (
  SELECT *, sum(CASE WHEN dt IS NULL OR dt > ${G} THEN 1 ELSE 0 END) OVER (PARTITION BY sensor_id, track_number ORDER BY ts) AS seg,
    max(ts) OVER () AS data_end FROM d
), trk AS (
  SELECT sensor_id, count(*) AS n, ${ms('min(ts)', 'max(ts)')} / 1000.0 AS dur, bool_or(track_end) AS ended, max(ts) AS last_ts, any_value(data_end) AS data_end
  FROM seg GROUP BY sensor_id, track_number, seg
)
SELECT sensor_id, count(*) AS tracks, round(median(dur) / 60, 1) AS median_duration_min, round(avg(dur) / 60, 1) AS avg_duration_min,
  round(max(dur) / 60, 1) AS max_duration_min, count(*) FILTER (WHERE n < 5) AS short_tracks,
  round(100.0 * count(*) FILTER (WHERE n < 5) / count(*), 1) AS short_track_pct,
  count(*) FILTER (WHERE NOT ended AND ${ms('last_ts', 'data_end')} > ${G * 1000}) AS dropped_tracks
FROM trk GROUP BY sensor_id ORDER BY sensor_id`,
        chart: { type: 'bar', x: 'sensor_id', y: ['median_duration_min'] },
        narrate: (rows) =>
          rows.length
            ? rows
                .map((r) => `**${r.sensor_id}**: ${fmt(r.tracks)} tracks, median ${fmt(r.median_duration_min)} min, ${fmt(r.short_track_pct)}% short, ${fmt(r.dropped_tracks)} dropped without end flag`)
                .join('; ')
            : 'No tracks in this period.',
        notes: [`A track silent for more than ${G}s (TRACK_GAP_S) counts as ended; "dropped" = ended without the ASTERIX track-end (TRE) flag; "short" = fewer than 5 updates.`],
      };
    },
  },
  {
    id: 'latency',
    title: 'Data latency',
    match: /\blatenc|\bdelay|\blag\b|\bhow\s+late\b|\btransmission\s+time\b/i,
    needs: ['received_at'],
    build: ({ t, where }) => ({
      sql: `SELECT sensor_id, round(avg(l), 3) AS avg_latency_s, round(quantile_cont(l, 0.95), 3) AS p95_latency_s, round(max(l), 3) AS max_latency_s, count(*) AS plots
FROM (SELECT sensor_id, ${ms('ts', 'received_at')} / 1000.0 AS l FROM ${t} WHERE ${where} AND received_at IS NOT NULL)
GROUP BY sensor_id ORDER BY p95_latency_s DESC`,
      chart: { type: 'bar', x: 'sensor_id', y: ['avg_latency_s', 'p95_latency_s'] },
      narrate: (rows) =>
        rows.length
          ? `Highest latency: **${rows[0].sensor_id}** (avg ${fmt(rows[0].avg_latency_s)} s, 95th percentile ${fmt(rows[0].p95_latency_s)} s). Lowest: ${rows.at(-1).sensor_id} (avg ${fmt(rows.at(-1).avg_latency_s)} s).`
          : 'No reception timestamps (received_at) in this period.',
    }),
  },
  {
    id: 'clutter',
    title: 'False plots, clutter and ghosts',
    match: /clutter|false\s+(?:plots?|targets?|alarms?|tracks?)|ghosts?|spurious|reflections?/i,
    needs: ['report_type'],
    build: ({ t, where, has }) => ({
      sql: `SELECT sensor_id, count(*) AS plots,
  ${has('ghost') ? 'count(*) FILTER (WHERE ghost)' : '0'} AS ghost_plots,
  count(*) FILTER (WHERE report_type = 'PSR' AND track_number IS NULL) AS unassociated_psr_plots,
  round(100.0 * (${has('ghost') ? 'count(*) FILTER (WHERE ghost) + ' : ''}count(*) FILTER (WHERE report_type = 'PSR' AND track_number IS NULL)) / count(*), 2) AS false_plot_pct
FROM ${t} WHERE ${where} GROUP BY sensor_id ORDER BY false_plot_pct DESC`,
      chart: { type: 'bar', x: 'sensor_id', y: ['false_plot_pct'] },
      narrate: (rows) =>
        rows.length
          ? `Most false plots: **${rows[0].sensor_id} ${fmt(rows[0].false_plot_pct)}%** (${fmt(rows[0].unassociated_psr_plots)} unassociated primary plots, ${fmt(rows[0].ghost_plots)} ghosts).`
          : 'No plots in this period.',
    }),
  },
];

const ALL_TIME = /\b(all\s+time|overall|entire|whole|ever|full\s+(?:data|history)|since\s+(?:the\s+)?(?:start|beginning))\b/i;

/**
 * Returns a radar analysis plan for the question, or null if the question is not a radar
 * analysis (then the general rule engine handles it).
 */
export function matchRadarAnalysis(question, schema, plan) {
  if (!schema.radar) return null;
  const analysis = ANALYSES.find((a) => a.match.test(question));
  if (!analysis) return null;
  const names = new Set(schema.columns.map((c) => c.name));
  const has = (n) => names.has(n);
  const missing = analysis.needs.filter((n) => !has(n));
  if (missing.length) {
    return { error: `${analysis.title} needs the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not in table ${schema.table}.` };
  }

  // Reuse filters from the general parser (time, sensor, aircraft, area) but not numeric
  // comparisons, which in these questions are thresholds for the analysis itself.
  const parts = (plan.whereParts ?? []).filter((p) => p.kind !== 'compare');
  const conds = parts.map((p) => p.sql);
  const descs = parts.map((p) => p.desc);
  const anchor = plan.anchor;
  let defaultWindow = null;
  if (!parts.some((p) => p.kind === 'time') && !ALL_TIME.test(question)) {
    const h = analysis.defaultWindowH ?? config.radar.defaultWindowH;
    conds.push(`ts > TIMESTAMP '${anchor}' - INTERVAL ${h} HOUR`);
    descs.push(`last ${h} h (to ${anchor.slice(0, 16)})`);
    defaultWindow = h;
  }
  const where = conds.length ? conds.join(' AND ') : 'TRUE';
  const built = analysis.build({ t: qi(schema.table), where, has, question, anchor });
  return {
    id: analysis.id,
    title: analysis.title,
    ...built,
    notes: [...(built.notes ?? []), ...(defaultWindow ? [`Covers the last ${defaultWindow} hours of data by default — add a period ("yesterday", "last 7 days") or say "all time".`] : [])],
    interpretation: [analysis.title.toLowerCase(), built.interpretation, descs.length ? `where ${descs.join(' and ')}` : null].filter(Boolean).join(' · '),
  };
}

export const RADAR_ANALYSIS_IDS = ANALYSES.map((a) => a.id);
