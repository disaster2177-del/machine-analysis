import { Fragment, useState } from 'react';
import Chart from './Chart.jsx';
import DataTable from './DataTable.jsx';

// Render **bold** segments from the server's plain-text answer.
function RichText({ text }) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export default function AnswerCard({ item, onRunSql, onAskAgain, llm }) {
  const r = item.response;
  const hasChart = r && r.chart && r.chart.type !== 'table' && r.rows?.length > (r.chart.type === 'map' ? 1 : 0);
  const [view, setView] = useState(null);
  const [sql, setSql] = useState(null);
  const current = view ?? (hasChart ? 'chart' : 'table');

  return (
    <article className="card">
      <div className="q">{item.question}</div>
      {item.loading && <div className="loading">Analysing…</div>}
      {item.error && <div className="error">{item.error}</div>}
      {r && (
        <>
          <div className="answer">
            <RichText text={r.answer ?? ''} />
          </div>
          {r.interpretation && (
            <div className="interpretation" title="How the question was understood">
              <span className="label">Understood as</span> {r.interpretation}
            </div>
          )}
          {r.notes?.map((n) => (
            <div key={n} className="note">
              {n}
            </div>
          ))}
          <div className="meta">
            <span className={`chip ${r.engine}`}>{r.engine === 'llm' ? `LLM · ${r.model}` : r.engine === 'sql' ? 'SQL' : 'Rules'}</span>
            {r.confidence && r.engine === 'rules' && <span className={`chip conf-${r.confidence}`}>{r.confidence} confidence</span>}
            <span className="chip">{r.cached ? 'cached' : `query ${r.timings?.queryMs ?? r.ms} ms`}</span>
            {r.timings?.llmMs != null && <span className="chip">LLM {r.timings.llmMs} ms</span>}
            <span className="chip">
              {r.rows.length.toLocaleString('en-IN')} row{r.rows.length === 1 ? '' : 's'}
              {r.truncated ? ' (truncated)' : ''}
            </span>
            {r.engine === 'rules' && llm?.available && (
              <button className="link" onClick={() => onAskAgain(item.question, 'llm')}>
                ask the local LLM instead
              </button>
            )}
          </div>
          <div className="views">
            {hasChart && (
              <button className={current === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>
                Chart
              </button>
            )}
            <button className={current === 'table' ? 'active' : ''} onClick={() => setView('table')}>
              Table
            </button>
            <button className={current === 'sql' ? 'active' : ''} onClick={() => setView('sql')}>
              SQL
            </button>
          </div>
          {current === 'chart' && hasChart && <Chart chart={r.chart} rows={r.rows} columns={r.columns} />}
          {current === 'table' && <DataTable columns={r.columns} rows={r.rows} />}
          {current === 'sql' && (
            <div className="sql">
              <textarea value={sql ?? r.sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} rows={6} />
              <div className="sql-actions">
                <button onClick={() => onRunSql(sql ?? r.sql)}>Run SQL</button>
                <span className="muted small">Read-only. Edit and re-run to refine the answer.</span>
              </div>
            </div>
          )}
        </>
      )}
    </article>
  );
}
