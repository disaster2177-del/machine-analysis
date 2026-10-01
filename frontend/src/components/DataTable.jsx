import { useMemo, useState } from 'react';
import { fmt, toCsv } from '../format.js';

const PAGE = 100;

export default function DataTable({ columns, rows }) {
  const [shown, setShown] = useState(PAGE);
  const [sort, setSort] = useState(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }, [rows, sort]);

  if (!rows.length) return <div className="muted small pad">No rows.</div>;

  const download = () => {
    const blob = new Blob([toCsv(columns, sorted)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'result.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const numeric = (c) => /INT|DOUBLE|FLOAT|DECIMAL|REAL/.test(c.type);

  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.name}
                  className={numeric(c) ? 'num' : ''}
                  onClick={() => setSort((s) => ({ key: c.name, dir: s?.key === c.name ? -s.dir : -1 }))}
                  title={`${c.type} — click to sort`}
                >
                  {c.name}
                  {sort?.key === c.name ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.name} className={numeric(c) ? 'num' : ''}>
                    {fmt(row[c.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span className="muted small">
          Showing {Math.min(shown, rows.length).toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')}
        </span>
        {shown < rows.length && (
          <button className="link" onClick={() => setShown((s) => s + PAGE * 5)}>
            show more
          </button>
        )}
        <button className="link" onClick={download}>
          download CSV
        </button>
      </div>
    </div>
  );
}
