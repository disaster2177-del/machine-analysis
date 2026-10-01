/** Quote an identifier for DuckDB. */
export const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
/** Quote a string literal for DuckDB. */
export const ql = (value) => `'${String(value).replace(/'/g, "''")}'`;
