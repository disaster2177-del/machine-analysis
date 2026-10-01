import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, fmtCompact, niceTicks, parseTs } from '../format.js';

const SERIES_VARS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const MAX_SERIES = 8;
const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const label = (k) => k.replace(/_/g, ' ');

export default function Chart({ chart, rows, columns }) {
  if (chart.type === 'stat') return <StatTiles rows={rows} />;
  if (chart.type === 'line') return <LineChart chart={chart} rows={rows} />;
  if (chart.type === 'bar') return <BarChart chart={chart} rows={rows} columns={columns} />;
  if (chart.type === 'map') return <MapChart chart={chart} rows={rows} />;
  return null;
}

function StatTiles({ rows }) {
  const row = rows[0];
  return (
    <div className="tiles">
      {Object.entries(row).map(([k, v]) => (
        <div key={k} className="tile">
          <div className="tile-label">{label(k)}</div>
          <div className="tile-value">{fmt(v)}</div>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.name}>
          <i style={{ background: it.color }} /> {it.name}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, children }) {
  const left = Math.min(x + 12, width - 200);
  return (
    <div className="tooltip" style={{ left: Math.max(0, left), top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

function LineChart({ chart, rows }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const height = 300;
  const m = { t: 12, r: 16, b: 28, l: 64 };

  const { series, xs, yMin, yMax, dropped } = useMemo(() => {
    const ySeries = [];
    let droppedCount = 0;
    if (chart.series) {
      const key = chart.y[0];
      const groups = new Map();
      for (const r of rows) {
        const s = String(r[chart.series]);
        if (!groups.has(s)) groups.set(s, []);
        groups.get(s).push(r);
      }
      // Keep the largest series; the rest are listed as dropped (never invent a 9th colour).
      const ranked = [...groups.entries()].sort(
        (a, b) => b[1].reduce((s, r) => s + Math.abs(r[key] ?? 0), 0) - a[1].reduce((s, r) => s + Math.abs(r[key] ?? 0), 0),
      );
      ranked.slice(0, MAX_SERIES).forEach(([name, rs]) =>
        ySeries.push({ name, points: rs.map((r) => ({ x: parseTs(r[chart.x]), y: r[key] })).filter((p) => p.y != null) }),
      );
      droppedCount = Math.max(0, ranked.length - MAX_SERIES);
    } else {
      for (const key of chart.y.slice(0, MAX_SERIES)) {
        ySeries.push({ name: label(key), points: rows.map((r) => ({ x: parseTs(r[chart.x]), y: r[key] })).filter((p) => p.y != null) });
      }
    }
    ySeries.forEach((s, i) => {
      s.color = SERIES_VARS[i];
      s.points.sort((a, b) => a.x - b.x);
    });
    const all = ySeries.flatMap((s) => s.points);
    const xsSet = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
    return {
      series: ySeries,
      xs: xsSet,
      yMin: Math.min(...all.map((p) => p.y)),
      yMax: Math.max(...all.map((p) => p.y)),
      dropped: droppedCount,
    };
  }, [chart, rows]);

  if (!xs.length) return null;
  const ticks = niceTicks(yMin, yMax);
  const y0 = ticks[0];
  const y1 = ticks.at(-1);
  const x0 = xs[0];
  const x1 = xs.at(-1) === x0 ? x0 + 1 : xs.at(-1);
  const sx = (x) => m.l + ((x - x0) / (x1 - x0)) * (width - m.l - m.r);
  const sy = (y) => m.t + (1 - (y - y0) / (y1 - y0 || 1)) * (height - m.t - m.b);
  const spanDays = (x1 - x0) / 86400000;
  const fmtX = (t) => {
    const d = new Date(t).toISOString();
    if (spanDays > 400) return d.slice(0, 7);
    if (spanDays > 2) return d.slice(0, 10);
    return d.slice(5, 16).replace('T', ' ');
  };
  const xTickCount = Math.max(2, Math.floor((width - m.l - m.r) / 110));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => x0 + ((x1 - x0) * i) / (xTickCount - 1));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = x0 + ((px - m.l) / (width - m.l - m.r)) * (x1 - x0);
    let best = xs[0];
    for (const x of xs) if (Math.abs(x - t) < Math.abs(best - t)) best = x;
    setHover({ x: best, px: sx(best), py: e.clientY - rect.top });
  };

  return (
    <div className="chart" ref={ref}>
      <Legend items={series} />
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={width - m.r} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={m.l - 8} y={sy(t)} className="axis" textAnchor="end" dominantBaseline="middle">
              {fmtCompact(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={sx(t)} y={height - 8} className="axis" textAnchor={i === 0 ? 'start' : i === xTickCount - 1 ? 'end' : 'middle'}>
            {fmtX(t)}
          </text>
        ))}
        {series.map((s) => (
          <path
            key={s.name}
            d={s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ))}
        {series.map((s) =>
          s.points.length <= 2 ? s.points.map((p) => <circle key={`${s.name}${p.x}`} cx={sx(p.x)} cy={sy(p.y)} r="4" fill={s.color} />) : null,
        )}
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={m.t} y2={height - m.b} className="crosshair" />
            {series.map((s) => {
              const p = s.points.find((q) => q.x === hover.x);
              return p ? <circle key={s.name} cx={hover.px} cy={sy(p.y)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" /> : null;
            })}
          </g>
        )}
      </svg>
      {hover && (
        <Tooltip x={hover.px} y={hover.py} width={width}>
          <div className="tt-title">{fmt(new Date(hover.x).toISOString().replace('T', ' ').slice(0, 19))}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === hover.x);
            return p ? (
              <div key={s.name} className="tt-row">
                <i style={{ background: s.color }} /> {s.name} <b>{fmt(p.y)}</b>
              </div>
            ) : null;
          })}
        </Tooltip>
      )}
      {dropped > 0 && <div className="muted small">Showing the {MAX_SERIES} largest series; {dropped} more are in the table.</div>}
    </div>
  );
}

function BarChart({ chart, rows }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);

  if (chart.histogram) {
    const key = chart.y[0];
    const height = 280;
    const m = { t: 12, r: 12, b: 28, l: 64 };
    const ticks = niceTicks(0, Math.max(...rows.map((r) => r[key])));
    const yTop = ticks.at(-1);
    const bw = (width - m.l - m.r) / rows.length;
    const sy = (v) => m.t + (1 - v / yTop) * (height - m.t - m.b);
    return (
      <div className="chart" ref={ref}>
        <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={width - m.r} y1={sy(t)} y2={sy(t)} className="grid" />
              <text x={m.l - 8} y={sy(t)} className="axis" textAnchor="end" dominantBaseline="middle">
                {fmtCompact(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => (
            <g key={i} onMouseEnter={() => setHover({ r, px: m.l + i * bw, py: sy(r[key]) })}>
              <rect x={m.l + i * bw} y={m.t} width={bw} height={height - m.t - m.b} fill="transparent" />
              <rect x={m.l + i * bw + 1} y={sy(r[key])} width={Math.max(1, bw - 2)} height={Math.max(0, height - m.b - sy(r[key]))} rx="2" fill="var(--series-1)" opacity={hover && hover.r !== r ? 0.6 : 1} />
            </g>
          ))}
          {rows
            .filter((_, i) => i % Math.ceil(rows.length / 8) === 0)
            .map((r) => (
              <text key={r.bucket_start} x={m.l + rows.indexOf(r) * bw} y={height - 8} className="axis">
                {fmtCompact(r[chart.x])}
              </text>
            ))}
        </svg>
        {hover && (
          <Tooltip x={hover.px} y={hover.py} width={width}>
            <div className="tt-title">
              {fmt(hover.r[chart.x])} – {fmt(hover.r[chart.x] + chart.binWidth)}
            </div>
            <div className="tt-row">
              records <b>{fmt(hover.r[key])}</b>
            </div>
          </Tooltip>
        )}
      </div>
    );
  }

  // Horizontal bars: readable category labels, one row per category.
  const keys = chart.y.slice(0, 3);
  const shown = rows.slice(0, 30);
  const rowH = keys.length > 1 ? 14 * keys.length + 10 : 26;
  const labelW = Math.min(180, Math.max(70, ...shown.map((r) => fmt(r[chart.x]).length * 7.2)));
  const valueW = 80;
  const height = shown.length * rowH + 8;
  const max = Math.max(0, ...shown.flatMap((r) => keys.map((k) => r[k] ?? 0)));
  const min = Math.min(0, ...shown.flatMap((r) => keys.map((k) => r[k] ?? 0)));
  const plotW = width - labelW - valueW - 8;
  const sx = (v) => labelW + ((v - min) / (max - min || 1)) * plotW;
  return (
    <div className="chart" ref={ref}>
      <Legend items={keys.map((k, i) => ({ name: label(k), color: SERIES_VARS[i] }))} />
      <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
        {shown.map((r, i) => {
          const y = 4 + i * rowH;
          const barH = keys.length > 1 ? 12 : 18;
          return (
            <g key={i} onMouseEnter={() => setHover({ r, px: labelW, py: y })}>
              <rect x="0" y={y} width={width} height={rowH} fill={hover?.r === r ? 'var(--hover)' : 'transparent'} />
              <text x={labelW - 8} y={y + rowH / 2} className="axis strong" textAnchor="end" dominantBaseline="middle">
                {fmt(r[chart.x]).slice(0, 24)}
              </text>
              {keys.map((k, j) => {
                const v = r[k] ?? 0;
                const by = y + (rowH - keys.length * (barH + 2)) / 2 + j * (barH + 2);
                return (
                  <g key={k}>
                    <rect x={Math.min(sx(0), sx(v))} y={by} width={Math.max(1, Math.abs(sx(v) - sx(0)))} height={barH} rx="3" fill={SERIES_VARS[j]} />
                    {keys.length === 1 && (
                      <text x={Math.max(sx(0), sx(v)) + 6} y={by + barH / 2} className="axis" dominantBaseline="middle">
                        {fmtCompact(v)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover && (
        <Tooltip x={hover.px} y={hover.py} width={width}>
          <div className="tt-title">{fmt(hover.r[chart.x])}</div>
          {keys.map((k, j) => (
            <div key={k} className="tt-row">
              <i style={{ background: SERIES_VARS[j] }} /> {label(k)} <b>{fmt(hover.r[k])}</b>
            </div>
          ))}
        </Tooltip>
      )}
      {rows.length > shown.length && <div className="muted small">Top {shown.length} of {rows.length} shown — see the table for all.</div>}
    </div>
  );
}

function MapChart({ chart, rows }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pts = rows.filter((r) => r[chart.lat] != null && r[chart.lon] != null);
  if (!pts.length) return null;
  const lats = pts.map((r) => r[chart.lat]);
  const lons = pts.map((r) => r[chart.lon]);
  let [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const pad = Math.max(la1 - la0, lo1 - lo0, 0.01) * 0.08;
  la0 -= pad;
  la1 += pad;
  lo0 -= pad;
  lo1 += pad;
  // Equirectangular projection with latitude correction so distances look right.
  const k = Math.cos((((la0 + la1) / 2) * Math.PI) / 180);
  const aspect = (la1 - la0) / ((lo1 - lo0) * k);
  const height = Math.min(460, Math.max(220, width * aspect));
  const sx = (lon) => ((lon - lo0) / (lo1 - lo0)) * width;
  const sy = (lat) => (1 - (lat - la0) / (la1 - la0)) * height;
  const colorKey = chart.color;
  const cvals = colorKey ? pts.map((r) => r[colorKey]).filter((v) => v != null) : [];
  const c0 = Math.min(...cvals);
  const c1 = Math.max(...cvals);
  const color = (r) => {
    if (!colorKey || r[colorKey] == null || c1 === c0) return 'var(--series-1)';
    return SEQ[Math.min(SEQ.length - 1, Math.floor(((r[colorKey] - c0) / (c1 - c0)) * SEQ.length))];
  };
  return (
    <div className="chart" ref={ref}>
      {colorKey && cvals.length > 0 && (
        <div className="legend">
          <span>{label(colorKey)}:</span>
          <span>{fmtCompact(c0)}</span>
          <span className="ramp" style={{ background: `linear-gradient(90deg, ${SEQ.join(',')})` }} />
          <span>{fmtCompact(c1)}</span>
        </div>
      )}
      <svg width={width} height={height} className="map" onMouseLeave={() => setHover(null)}>
        {niceTicks(la0, la1, 4).filter((t) => sy(t) > 16 && sy(t) < height - 20).map((t) => (
          <g key={`la${t}`}>
            <line x1="0" x2={width} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x="4" y={sy(t) - 3} className="axis">
              {t}°
            </text>
          </g>
        ))}
        {niceTicks(lo0, lo1, 5).filter((t) => sx(t) > 40 && sx(t) < width - 50).map((t) => (
          <g key={`lo${t}`}>
            <line y1="0" y2={height} x1={sx(t)} x2={sx(t)} className="grid" />
            <text x={sx(t) + 3} y={height - 4} className="axis">
              {t}°
            </text>
          </g>
        ))}
        {pts.map((r, i) => (
          <circle
            key={i}
            cx={sx(r[chart.lon])}
            cy={sy(r[chart.lat])}
            r={hover?.r === r ? 6 : 4}
            fill={color(r)}
            stroke="var(--surface)"
            strokeWidth="1"
            onMouseEnter={() => setHover({ r, px: sx(r[chart.lon]), py: sy(r[chart.lat]) })}
          />
        ))}
      </svg>
      {hover && (
        <Tooltip x={hover.px} y={hover.py} width={width}>
          {Object.entries(hover.r)
            .slice(0, 10)
            .map(([key, v]) => (
              <div key={key} className="tt-row">
                {key} <b>{fmt(v)}</b>
              </div>
            ))}
        </Tooltip>
      )}
      <div className="muted small">
        {pts.length.toLocaleString('en-IN')} points plotted by latitude/longitude (offline — no map tiles).
      </div>
    </div>
  );
}
