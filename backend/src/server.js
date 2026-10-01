import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { fileSignature, openDatabase, query, reloadIfChanged } from './db.js';
import { loadSchema, publicSchema, refreshSchema } from './schema.js';
import { parseQuestion } from './nlq/ruleParser.js';
import { guardSql } from './nlq/sqlGuard.js';
import { generateSql, llmStatus, summarize } from './nlq/llm.js';
import { inferChart, narrate } from './nlq/narrate.js';
import { suggestQuestions } from './nlq/suggestions.js';
import { matchRadarAnalysis } from './radar/analytics.js';

const t0 = Date.now();
await openDatabase();
let schema = await loadSchema();
let lastFullScan = Date.now();
let dataVersion = 1;
let reloadedAt = new Date().toISOString();
let seenSignature = fileSignature();

// Pick up new data written to the DuckDB file by your ingest process.
let reloading = false;
setInterval(async () => {
  if (reloading) return;
  reloading = true;
  try {
    const sig = fileSignature();
    if (sig !== seenSignature) {
      seenSignature = sig;
      await reloadIfChanged();
      const full = Date.now() - lastFullScan > 10 * 60 * 1000;
      schema = full ? await loadSchema() : await refreshSchema(schema);
      if (full) lastFullScan = Date.now();
      dataVersion++;
      reloadedAt = new Date().toISOString();
      console.log(`Database changed: reloaded (${schema.rowCount.toLocaleString('en-IN')} rows, latest ${schema.timeRange?.max ?? '-'})`);
    }
  } catch (err) {
    console.warn(`Reload skipped: ${err.message}`);
  } finally {
    reloading = false;
  }
}, config.reloadCheckMs).unref();
console.log(`Loaded table "${schema.table}": ${schema.rowCount.toLocaleString('en-IN')} rows, ${schema.columns.length} columns (${Date.now() - t0} ms)`);

const parseOptions = {
  relativeTimeAnchor: config.relativeTimeAnchor,
  dateOrder: config.dateOrder,
  defaultListLimit: config.defaultListLimit,
};

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/schema', async (_req, res) => {
  res.json({ ...publicSchema(schema), suggestions: suggestQuestions(schema), llm: await llmStatus() });
});

app.get('/api/status', (_req, res) => {
  res.json({ rowCount: schema.rowCount, timeRange: schema.timeRange, dataVersion, reloadedAt });
});

app.get('/api/llm/status', async (_req, res) => res.json(await llmStatus(true)));

async function runLlm(question, anchor) {
  const started = performance.now();
  let sql = guardSql(await generateSql(question, schema, anchor));
  let result;
  try {
    result = await query(sql);
  } catch (err) {
    // One self-correction round with the database error message.
    sql = guardSql(await generateSql(question, schema, anchor, { sql, error: err.message }));
    result = await query(sql);
  }
  return { sql, result, llmMs: Math.round(performance.now() - started - result.ms) };
}

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  const engine = ['auto', 'rules', 'llm'].includes(req.body?.engine) ? req.body.engine : 'auto';
  if (!question) return res.status(400).json({ error: 'Please type a question.' });

  try {
    const p0 = performance.now();
    const plan = parseQuestion(question, schema, parseOptions);
    const parseMs = +(performance.now() - p0).toFixed(2);
    const notes = [...plan.notes];

    // Radar surveillance analyses (Pd, scan period, gaps, bias, emergencies, ...)
    const radar = engine !== 'llm' ? matchRadarAnalysis(question, schema, plan) : null;
    if (radar?.error) return res.status(400).json({ error: radar.error });
    if (radar) {
      const result = await query(radar.sql);
      if (radar.postprocess) result.rows = radar.postprocess(result.rows);
      if (radar.postprocess && result.rows[0]) result.columns = [{ name: Object.keys(result.rows[0])[0], type: 'VARCHAR' }, ...result.columns];
      const limit = Number(radar.sql.match(/LIMIT (\d+)\s*$/)?.[1]);
      const capped = limit && result.rows.length >= limit;
      let answer = radar.narrate(result.rows);
      if (capped) answer = answer.replace(/\*\*(\d[\d,]*) /, '**at least $1 ');
      return res.json({
        question,
        engine: 'rules',
        analysis: radar.id,
        answer: capped ? `${answer} (Only the first ${limit} are listed; add a sensor or period to narrow it down.)` : answer,
        interpretation: radar.interpretation,
        sql: radar.sql,
        confidence: 'high',
        unknownWords: [],
        chart: radar.chart,
        ...result,
        notes: [...notes, ...(radar.notes ?? [])],
        timings: { parseMs, queryMs: result.ms },
      });
    }

    const llm = engine === 'rules' || (engine === 'auto' && plan.confidence === 'high') ? null : await llmStatus();
    const useLlm = engine === 'llm' || (engine === 'auto' && plan.confidence !== 'high' && llm?.available);

    if (engine === 'llm' && !llm.available) {
      return res.status(503).json({ error: `Local LLM is not available: ${llm.error}` });
    }

    if (useLlm) {
      try {
        const { sql, result, llmMs } = await runLlm(question, plan.anchor);
        const chart = inferChart(result.columns, result.rows, schema);
        let answer;
        if (req.body?.summarize !== false) {
          try {
            answer = await summarize(question, sql, result.columns, result.rows);
          } catch {
            /* fall through to template */
          }
        }
        answer ??= narrate({ mode: chart.type === 'stat' ? 'aggregate' : 'llm', chart, measureCols: [], sql }, result);
        return res.json({
          question,
          engine: 'llm',
          model: llm.model,
          answer,
          interpretation: `Generated by local model ${llm.model}`,
          sql,
          confidence: 'llm',
          chart,
          ...result,
          notes,
          timings: { parseMs, llmMs, queryMs: result.ms },
        });
      } catch (err) {
        if (engine === 'llm') throw err;
        notes.push(`The local LLM could not answer (${err.message}); showing the rule-based interpretation instead.`);
      }
    }

    if (plan.confidence !== 'high') {
      const words = plan.unknownWords.length ? `I did not understand: ${plan.unknownWords.map((w) => `"${w}"`).join(', ')}. ` : '';
      notes.push(
        `${words}This is my best interpretation — check it below.${llm && !llm.available && engine === 'auto' ? ' Start a local LLM (see README) to handle free-form questions.' : ''}`,
      );
    }

    const [result, count] = await Promise.all([
      query(plan.sql),
      plan.countSql ? query(plan.countSql).catch(() => null) : null,
    ]);
    const totalCount = count?.rows?.[0]?.total ?? null;
    res.json({
      question,
      engine: 'rules',
      answer: narrate(plan, result, totalCount),
      interpretation: plan.interpretation,
      sql: plan.sql,
      confidence: plan.confidence,
      unknownWords: plan.unknownWords,
      chart: plan.chart,
      totalCount,
      ...result,
      notes,
      timings: { parseMs, queryMs: result.ms + (count?.ms ?? 0) },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Run SQL edited by the user in the UI (read-only, guarded).
app.post('/api/sql', async (req, res) => {
  try {
    const sql = guardSql(req.body?.sql);
    const result = await query(sql);
    const chart = inferChart(result.columns, result.rows, schema);
    res.json({
      engine: 'sql',
      sql,
      chart,
      answer: narrate({ mode: 'sql', chart, measureCols: [], sql }, result),
      ...result,
      notes: [],
      timings: { queryMs: result.ms },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Serve the built React app (same port, works fully offline).
if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.staticDir, 'index.html')));
}

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Machine analysis API on http://127.0.0.1:${config.port}`);
  llmStatus(true).then((s) =>
    console.log(s.available ? `Local LLM ready: ${s.model}` : `Local LLM not available (rule engine only). ${s.error ?? ''}`),
  );
});
