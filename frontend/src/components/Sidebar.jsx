import { useState } from 'react';
import { crore, fmt } from '../format.js';

const KIND_LABEL = { time: 'time', numeric: 'number', category: 'category', text: 'text', boolean: 'bool', other: 'other' };

export default function Sidebar({ schema, status, error, onPick, history, onRefreshLlm }) {
  const [tab, setTab] = useState('examples');
  if (error) {
    return (
      <aside className="sidebar">
        <div className="brand">Analysis</div>
        <div className="error">Cannot reach the backend: {error}</div>
      </aside>
    );
  }
  if (!schema) {
    return (
      <aside className="sidebar">
        <div className="brand">Analysis</div>
        <div className="muted">Loading dataset…</div>
      </aside>
    );
  }
  const { llm } = schema;
  const rowCount = status?.rowCount ?? schema.rowCount;
  const timeRange = status?.timeRange ?? schema.timeRange;
  return (
    <aside className="sidebar">
      <div className="brand">{schema.radar ? 'Radar Analysis' : 'Machine Analysis'}</div>
      <div className="dataset">
        <div className="big">{crore(rowCount)}</div>
        <div className="muted">
          rows in <code>{schema.table}</code>
        </div>
        {timeRange && (
          <div className="muted small">
            {fmt(timeRange.min)} → {fmt(timeRange.max)}
          </div>
        )}
        {schema.radar && <div className="muted small">ASTERIX CAT048 radar plots</div>}
        {status?.reloadedAt && <div className="muted small">data loaded {new Date(status.reloadedAt).toLocaleTimeString()} · auto-refresh on</div>}
        <div className={`llm ${llm?.available ? 'on' : 'off'}`} title={llm?.error ?? ''}>
          <span className="dot" /> {llm?.available ? `Local LLM: ${llm.model}` : 'Rule engine only (no local LLM)'}
          <button className="link" onClick={onRefreshLlm} title="Check again">
            ↻
          </button>
        </div>
      </div>

      <div className="tabs">
        {['examples', 'columns', 'history'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'examples' && (
        <ul className="list">
          {schema.suggestions.map((s) => (
            <li key={s}>
              <button className="suggestion" onClick={() => onPick(s)}>
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'columns' && (
        <ul className="list columns">
          {schema.columns.map((c) => (
            <li key={c.name}>
              <div className="col-head">
                <code>{c.name}</code>
                <span className={`kind ${c.kind}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
              </div>
              {c.description && (
                <div className="small">
                  {c.description}
                  {c.standardItem && <span className="muted"> · {c.standardItem}</span>}
                </div>
              )}
              <div className="muted small">
                {c.kind === 'numeric' && `${fmt(c.min)} … ${fmt(c.max)}`}
                {c.kind === 'time' && `${fmt(c.min)} … ${fmt(c.max)}`}
                {c.kind === 'category' && `${c.distinct} values: ${c.sampleValues.join(', ')}${c.distinct > c.sampleValues.length ? '…' : ''}`}
                {c.kind === 'text' && `~${fmt(c.distinct)} distinct values`}
                {c.name === schema.latColumn && ' · latitude'}
                {c.name === schema.lonColumn && ' · longitude'}
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'history' && (
        <ul className="list">
          {!history.length && <li className="muted small">No questions yet.</li>}
          {history.map((h) => (
            <li key={h}>
              <button className="suggestion" onClick={() => onPick(h)}>
                {h}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
