/**
 * Read-only guard for the SQL console (DuckDB-WASM).
 *
 * The console exists so analysts can QUERY the loaded transactions. It must never be a way to write files, load extensions,
 * fetch remote URLs (data exfiltration), change engine settings, or chain a second statement. Everything is rejected unless it
 * is ONE statement that starts with SELECT / WITH / FROM / EXPLAIN / DESCRIBE / SHOW / SUMMARIZE / VALUES and contains none of
 * the denied keywords or file/URL-reading table functions. Values still never get concatenated into SQL elsewhere (sqlStr()).
 */
const START = /^(select|with|from|explain|describe|show|summarize|values|table)\b/i;
const DENY = /\b(copy|attach|detach|install|load|force|export|import|pragma|call|set|reset|use|create|drop|alter|insert|update|delete|truncate|vacuum|checkpoint|merge|grant|revoke|begin|commit|rollback|getenv|current_setting|glob|read_\w+|write_\w+|\w+_scan|duckdb_\w+|pragma_\w+|sniff_csv|http\w*|query_table|query\s*\()/i;

/** Blank out comments and literals so keyword checks cannot be fooled (or tripped) by text inside strings. Returns null on unterminated input. */
function skeleton(sql: string): string | null {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const c = sql[i], d = sql[i + 1];
    if (c === "-" && d === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += " "; continue; }
    if (c === "/" && d === "*") { const e = sql.indexOf("*/", i + 2); if (e < 0) return null; i = e + 2; out += " "; continue; }
    if (c === "$" && d === "$") { const e = sql.indexOf("$$", i + 2); if (e < 0) return null; i = e + 2; out += "'S'"; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, body = "";
      for (; j < sql.length; j++) { if (sql[j] === c) { if (sql[j + 1] === c) { body += c; j++; continue; } break; } body += sql[j]; }
      if (j >= sql.length) return null;
      // a quoted name containing . / \ : is a FILE or URL replacement-scan ("data.csv", "https://..."), never a table of ours
      out += c === "'" || /[./\\:]/.test(body) ? "'S'" : '"I"';
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

export function sqlReadOnlyError(sql: string): string | null {
  if (typeof sql !== "string" || !sql.trim()) return "Empty query.";
  if (sql.length > 20_000) return "Query is too long (max 20,000 characters).";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sql)) return "Query contains control characters.";
  const sk = skeleton(sql);
  if (sk === null) return "Unterminated string, identifier or comment.";
  const stmts = sk.split(";").map((x) => x.trim()).filter(Boolean);
  if (stmts.length !== 1) return "Only a single statement is allowed.";
  if (!START.test(stmts[0])) return "Only read-only queries are allowed (SELECT / WITH / EXPLAIN / DESCRIBE / SHOW / SUMMARIZE).";
  if (/\b(from|join)\s*'S'/i.test(stmts[0])) return "Reading files or URLs from SQL is blocked; query the loaded table txns.";
  const m = DENY.exec(stmts[0]);
  if (m) return `"${m[0].trim().toUpperCase()}" is not allowed in the read-only console.`;
  return null;
}

export function assertReadOnlySql(sql: string): void {
  const e = sqlReadOnlyError(sql);
  if (e) throw new Error("Blocked by the read-only SQL guard: " + e);
}
