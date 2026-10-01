// Defence in depth for SQL that did not come from the rule engine (LLM output or SQL
// typed in the UI). The database itself is also opened READ_ONLY with external access
// disabled and configuration locked, so even a missed case cannot modify data or touch files.

const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|copy|export|import|install|load|pragma|set|reset|call|checkpoint|vacuum|use|begin|commit|rollback|grant|revoke|truncate|replace\s+into|merge)\b/i;
const FORBIDDEN_FUNCS = /\b(read_\w+|glob|sniff_csv|parquet_\w+|query_table|query|getenv|current_setting|duckdb_\w+|pragma_\w+|httpfs\w*)\s*\(/i;

export function stripLiterals(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** Returns a cleaned single SELECT statement or throws with a readable reason. */
export function guardSql(input) {
  let sql = String(input ?? '').trim();
  sql = sql.replace(/^```(?:sql)?/i, '').replace(/```$/, '').trim();
  sql = sql.replace(/;\s*$/, '').trim();
  if (!sql) throw new Error('Empty SQL');
  const bare = stripLiterals(sql);
  if (bare.includes(';')) throw new Error('Only a single SQL statement is allowed');
  if (!/^\s*(select|with|from|\()/i.test(bare)) throw new Error('Only SELECT queries are allowed');
  const kw = bare.match(FORBIDDEN);
  if (kw) throw new Error(`Keyword "${kw[1].toUpperCase()}" is not allowed (read-only analysis)`);
  const fn = bare.match(FORBIDDEN_FUNCS);
  if (fn) throw new Error(`Function "${fn[1]}" is not allowed`);
  return sql;
}
