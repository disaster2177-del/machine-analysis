import { useEffect, useRef, useState } from 'react';
import { ask, getLlmStatus, getSchema, getStatus, runSql } from './api.js';
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

  const [status, setStatus] = useState(null);
  const liveRef = useRef(new Map());

  useEffect(() => {
    getSchema().then(setSchema).catch((e) => setSchemaError(e.message));
  }, []);

  // Poll for new data written to the database; re-run "live" answers when it changes.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const tick = async () => {
      let s;
      try {
        s = await getStatus();
      } catch {
        return;
      }
      setStatus(s);
      for (const it of itemsRef.current) {
        if (!it.live || it.dataVersion === s.dataVersion || liveRef.current.get(it.id)) continue;
        liveRef.current.set(it.id, true);
        ask(it.question, 'rules')
          .then((response) =>
            setItems((p) => p.map((x) => (x.id === it.id ? { ...x, response, dataVersion: s.dataVersion, updatedAt: new Date() } : x))),
          )
          .catch(() => {})
          .finally(() => liveRef.current.delete(it.id));
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, []);

  const toggleLive = (id) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, live: !it.live, dataVersion: status?.dataVersion } : it)));

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
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, loading: false, response, dataVersion: status?.dataVersion } : it)));
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
      <Sidebar schema={schema} status={status} error={schemaError} onPick={(q) => submit(q)} history={history} onRefreshLlm={refreshLlm} />
      <main className="main">
        <div className="stream">
          {!items.length && (
            <div className="empty">
              <h1>Ask anything about your {schema?.radar ? 'radar' : 'machine'} data</h1>
              <p>
                Questions are answered from the local database — nothing leaves this computer. Try one of the examples on the
                left, or type e.g.{' '}
                <em>{schema?.radar ? '“probability of detection by sensor yesterday”' : '“average max value per day for Pune last month”'}</em>.
              </p>
            </div>
          )}
          {items.map((it) => (
            <AnswerCard key={it.id} item={it} onToggleLive={() => toggleLive(it.id)} onRunSql={submitSql} onAskAgain={(q, mode) => submit(q, mode)} llm={schema?.llm} />
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
