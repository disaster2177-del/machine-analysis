import { useEffect, useRef, useState } from 'react';
import { ask, getLlmStatus, getSchema, runSql } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import AnswerCard from './components/AnswerCard.jsx';

const HISTORY_KEY = 'machine-analysis:history';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export default function App() {
  const [schema, setSchema] = useState(null);
  const [schemaError, setSchemaError] = useState(null);
  const [items, setItems] = useState([]);
  const [question, setQuestion] = useState('');
  const [engine, setEngine] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [historyPos, setHistoryPos] = useState(-1);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    getSchema().then(setSchema).catch((e) => setSchemaError(e.message));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length]);

  const remember = (q) => {
    const next = [q, ...history.filter((h) => h !== q)].slice(0, 50);
    setHistory(next);
    setHistoryPos(-1);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };

  async function submit(text, mode = engine) {
    const q = text.trim();
    if (!q || busy) return;
    const id = crypto.randomUUID?.() ?? String(Date.now());
    setItems((prev) => [...prev, { id, question: q, loading: true }]);
    setQuestion('');
    remember(q);
    setBusy(true);
    const started = performance.now();
    try {
      const response = await ask(q, mode);
      response.roundTripMs = Math.round(performance.now() - started);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, loading: false, response } : it)));
    } catch (err) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, loading: false, error: err.message } : it)));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function submitSql(sql) {
    const id = crypto.randomUUID?.() ?? String(Date.now());
    setItems((prev) => [...prev, { id, question: 'Custom SQL', loading: true }]);
    const started = performance.now();
    try {
      const response = await runSql(sql);
      response.roundTripMs = Math.round(performance.now() - started);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, loading: false, response } : it)));
    } catch (err) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, loading: false, error: err.message } : it)));
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(question);
    } else if (e.key === 'ArrowUp' && (!question || historyPos >= 0) && history.length) {
      e.preventDefault();
      const pos = Math.min(historyPos + 1, history.length - 1);
      setHistoryPos(pos);
      setQuestion(history[pos]);
    } else if (e.key === 'ArrowDown' && historyPos >= 0) {
      e.preventDefault();
      const pos = historyPos - 1;
      setHistoryPos(pos);
      setQuestion(pos >= 0 ? history[pos] : '');
    }
  }

  const refreshLlm = () => getLlmStatus().then((llm) => setSchema((s) => ({ ...s, llm })));

  return (
    <div className="layout">
      <Sidebar schema={schema} error={schemaError} onPick={(q) => submit(q)} history={history} onRefreshLlm={refreshLlm} />
      <main className="main">
        <div className="stream">
          {!items.length && (
            <div className="empty">
              <h1>Ask anything about your machine data</h1>
              <p>
                Questions are answered from the local database — nothing leaves this computer. Try one of the examples on the
                left, or type e.g. <em>“average max value per day for Pune last month”</em>.
              </p>
            </div>
          )}
          {items.map((it) => (
            <AnswerCard key={it.id} item={it} onRunSql={submitSql} onAskAgain={(q, mode) => submit(q, mode)} llm={schema?.llm} />
          ))}
          <div ref={bottomRef} />
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(question);
          }}
        >
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question about the data…  (Enter to send, ↑ for history)"
            rows={1}
            autoFocus
            disabled={!schema}
          />
          <select value={engine} onChange={(e) => setEngine(e.target.value)} title="Answer engine">
            <option value="auto">Auto</option>
            <option value="rules">Rules (instant)</option>
            <option value="llm">Local LLM</option>
          </select>
          <button type="submit" disabled={!question.trim() || busy || !schema}>
            {busy ? 'Working…' : 'Ask'}
          </button>
        </form>
      </main>
    </div>
  );
}
