// Optional local LLM (Ollama or any OpenAI-compatible server on localhost) used for
// questions the rule engine cannot understand. Nothing is sent outside the machine.

import { config } from '../config.js';

let status = { available: false, checkedAt: 0, models: [], error: null };

async function http(path, body, timeoutMs) {
  const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM server responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function llmStatus(force = false) {
  if (config.llm.provider === 'none') return { available: false, provider: 'none', model: null };
  if (!force && Date.now() - status.checkedAt < 30000) return { ...status, provider: config.llm.provider, model: config.llm.model };
  try {
    let models;
    if (config.llm.provider === 'openai') models = (await http('/v1/models', null, 1500)).data?.map((m) => m.id) ?? [];
    else models = (await http('/api/tags', null, 1500)).models?.map((m) => m.name) ?? [];
    const has = config.llm.provider === 'openai' || models.some((m) => m === config.llm.model || m.split(':')[0] === config.llm.model);
    status = {
      available: has,
      checkedAt: Date.now(),
      models,
      error: has ? null : `Model "${config.llm.model}" is not pulled. Run: ollama pull ${config.llm.model}`,
    };
  } catch (err) {
    status = { available: false, checkedAt: Date.now(), models: [], error: `No local LLM at ${config.llm.baseUrl} (${err.message})` };
  }
  return { ...status, provider: config.llm.provider, model: config.llm.model };
}

async function chat(messages) {
  if (config.llm.provider === 'openai') {
    const out = await http('/v1/chat/completions', { model: config.llm.model, messages, temperature: 0 }, config.llm.timeoutMs);
    return out.choices?.[0]?.message?.content ?? '';
  }
  const out = await http(
    '/api/chat',
    { model: config.llm.model, messages, stream: false, options: { temperature: 0, num_ctx: 8192 } },
    config.llm.timeoutMs,
  );
  return out.message?.content ?? '';
}

function schemaPrompt(schema, anchor) {
  const lines = schema.columns.map((c) => {
    let extra = '';
    if (c.kind === 'category') extra = ` -- values: ${c.values.slice(0, 25).map((v) => `'${v}'`).join(', ')}${c.values.length > 25 ? ', ...' : ''}`;
    else if (c.kind === 'numeric' || c.kind === 'time') extra = ` -- range ${c.min} .. ${c.max}`;
    else if (c.kind === 'text') extra = ` -- free text, ~${c.distinct} distinct values`;
    return `  "${c.name}" ${c.type}${extra}`;
  });
  const roles = [
    schema.timeColumn && `Timestamp column: "${schema.timeColumn}". "Now" / latest data = TIMESTAMP '${anchor}'.`,
    schema.latColumn && schema.lonColumn && `Location columns: "${schema.latColumn}" (latitude), "${schema.lonColumn}" (longitude). For distance in km use 2*6371*asin(sqrt(pow(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*pow(sin(radians(lon2-lon1)/2),2))).`,
  ].filter(Boolean);
  return `Table "${schema.table}" (${schema.rowCount} rows):\n${lines.join('\n')}\n${roles.join('\n')}`;
}

const SYSTEM = `You translate questions into a single DuckDB SQL SELECT query.
Rules:
- Output ONLY the SQL inside one \`\`\`sql code block, no explanation.
- Read-only: a single SELECT (CTEs allowed). Never modify data.
- Use only the table and columns given. Quote identifiers with double quotes.
- Use DuckDB functions: date_trunc('day', ts), strftime, quantile_cont, median, corr, count(DISTINCT x).
- Relative dates ("last 7 days", "today") are relative to the given latest-data timestamp, not now().
- Text matching on category values should use the exact values listed; use ILIKE for partial text.
- Give result columns short descriptive aliases (e.g. avg_max_value).
- Aggregate when the question asks for totals, averages, counts, trends; for trends group by a date_trunc bucket and ORDER BY it.
- When listing raw rows, add ORDER BY and LIMIT 100 unless the user asks for a different number.
- The table is very large (crores of rows): never SELECT * without LIMIT.`;

export function extractSql(text) {
  const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = text.search(/\b(with|select)\b/i);
  return start >= 0 ? text.slice(start).trim() : text.trim();
}

export async function generateSql(question, schema, anchor, previous) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${schemaPrompt(schema, anchor)}\n\nQuestion: ${question}` },
  ];
  if (previous) {
    messages.push({ role: 'assistant', content: `\`\`\`sql\n${previous.sql}\n\`\`\`` });
    messages.push({ role: 'user', content: `That query failed with: ${previous.error}\nReturn a corrected query.` });
  }
  return extractSql(await chat(messages));
}

export async function summarize(question, sql, columns, rows) {
  const sample = rows.slice(0, 30);
  const content = `Question: ${question}\nSQL used: ${sql}\nResult columns: ${columns.map((c) => c.name).join(', ')}\nResult (${rows.length} rows${rows.length > 30 ? ', first 30 shown' : ''}):\n${JSON.stringify(sample)}\n\nAnswer the question in 1-3 short sentences using only these numbers. Do not mention SQL.`;
  return (await chat([{ role: 'user', content }])).trim();
}
