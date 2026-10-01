async function call(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`);
  return data;
}

export const getSchema = () => call('/schema');
export const ask = (question, engine) => call('/ask', { question, engine });
export const runSql = (sql) => call('/sql', { sql });
export const getLlmStatus = () => call('/llm/status');
