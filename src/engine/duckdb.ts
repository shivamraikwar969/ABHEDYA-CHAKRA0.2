import type * as DuckDB from "@duckdb/duckdb-wasm";
import type { ColumnMapping } from "./types";
import { assertReadOnlySql } from "@/utils/sqlGuard";

export type EngineStatus = "idle" | "loading" | "ready" | "unavailable";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  ms: number;
  rowCount: number;
}

class DuckEngine {
  status: EngineStatus = "idle";
  error = "";
  version = "";
  private db: DuckDB.AsyncDuckDB | null = null;
  private conn: DuckDB.AsyncDuckDBConnection | null = null;
  private listeners = new Set<() => void>();
  tableLoaded = false;
  optimised = false;
  indexed = false;
  loadMs = 0;

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach((l) => l()); }

  async init(timeoutMs = 25000): Promise<void> {
    if (this.status !== "idle") return;
    this.status = "loading"; this.emit();
    try {
      const run = async () => {
        const duckdb = await import("@duckdb/duckdb-wasm");
        const bundles = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(bundles);
        if (!bundle.mainWorker) throw new Error("No compatible DuckDB bundle for this browser");
        const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
        const worker = new Worker(workerUrl);
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(workerUrl);
        this.db = db;
        this.conn = await db.connect();
        this.version = await db.getVersion();
      };
      await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error("DuckDB-WASM load timed out (offline?)")), timeoutMs))]);
      this.status = "ready";
    } catch (e) {
      this.status = "unavailable";
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.emit();
  }

  get ready() { return this.status === "ready" && !!this.conn; }

  async loadDataset(source: File | string, headers: string[], mapping: ColumnMapping): Promise<number> {
    if (!this.db || !this.conn) throw new Error("DuckDB not ready");
    const t0 = performance.now();
    const duckdb = await import("@duckdb/duckdb-wasm");
    const fname = "setu_dataset.csv";
    try { await this.db.dropFile(fname); } catch { /* ignore */ }
    if (typeof source === "string") await this.db.registerFileText(fname, source);
    else await this.db.registerFileHandle(fname, source, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    const q = (s: string) => '"' + s.replace(/"/g, '""') + '"';
    const alias = (key: keyof ColumnMapping, name: string) => (mapping[key] >= 0 ? `${q(headers[mapping[key]])} AS ${name}` : `NULL AS ${name}`);
    await this.conn.query(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv('${fname}', header=true, all_varchar=true, ignore_errors=true, sample_size=-1)`);
    // OPTIMISATION: cast ONCE into a typed table physically clustered by (sender, ts). Zone maps then prune row groups on
    // `sender = ?` / `ts >= ?`, and every query stops re-parsing VARCHAR on each run (the old `txns` VIEW re-cast all rows per query).
    const typed = `SELECT ${alias("txnId", "txn_id")}, ${alias("sender", "sender")}, ${alias("receiver", "receiver")},
      TRY_CAST(${mapping.amount >= 0 ? `replace(${q(headers[mapping.amount])}, ',', '')` : "NULL"} AS DOUBLE) AS amount,
      ${mapping.timestamp >= 0 ? `TRY_CAST(${q(headers[mapping.timestamp])} AS TIMESTAMP)` : "NULL"} AS ts,
      ${alias("mode", "mode")}, ${alias("ifscS", "sender_ifsc")}, ${alias("ifscR", "receiver_ifsc")}, ${alias("narration", "narration")}, ${alias("ip", "ip_address")}, ${alias("device", "device_type")} FROM raw`;
    for (const drop of ["DROP VIEW IF EXISTS txns", "DROP TABLE IF EXISTS txns"]) { try { await this.conn.query(drop); } catch { /* other object kind */ } }
    try {
      await this.conn.query(`CREATE TABLE txns AS SELECT * FROM (${typed}) ORDER BY sender, ts`);
      await this.conn.query(`DROP TABLE IF EXISTS raw`); // free the all-VARCHAR copy
      this.optimised = true;
    } catch (e) {
      // memory pressure etc. -> fall back to the original lazy view so the SQL console keeps working
      console.warn("Typed txns table failed, using view", e);
      await this.conn.query(`CREATE OR REPLACE VIEW txns AS ${typed}`);
      this.optimised = false;
    }
    if (this.optimised) this.buildIndexes(); // background: never blocks the UI or the first query
    this.tableLoaded = true;
    this.loadMs = performance.now() - t0;
    this.emit();
    return this.loadMs;
  }

  /** ART index on sender/receiver for highly selective point lookups (hop expansion). Built after load, best effort. */
  private buildIndexes() {
    const c = this.conn;
    if (!c) return;
    (async () => {
      try {
        await c.query(`CREATE INDEX IF NOT EXISTS idx_txns_sender ON txns(sender)`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_txns_receiver ON txns(receiver)`);
        this.indexed = true;
      } catch { /* index is an accelerator only */ }
    })();
  }

  /**
   * 4-hop traceback using indexed TEMP tables, one per hop (frontier -> join -> next frontier).
   * Mirrors engine/trail.ts: chronological (outflow >= inbound time), per-node branch cap by amount, cycle edges recorded but not expanded.
   */
  async traceback(victim: string, opts: { branchCap?: number; minAmount?: number; hops?: number } = {}): Promise<QueryResult> {
    if (!this.conn) throw new Error("DuckDB not ready");
    const t0 = performance.now();
    const hops = Math.min(4, Math.max(1, opts.hops ?? 4));
    const v = sqlStr(victim);
    const cap = Math.max(1, Math.floor(opts.branchCap ?? 25));
    const min = Number.isFinite(opts.minAmount) ? Number(opts.minAmount) : 0;
    const c = this.conn;
    await c.query(`CREATE OR REPLACE TEMP TABLE tb_visited AS SELECT ${v} AS acc`);
    await c.query(`CREATE OR REPLACE TEMP TABLE tb_frontier AS SELECT ${v} AS acc, TIMESTAMP '1900-01-01' AS min_ts`);
    const parts: string[] = [];
    for (let h = 1; h <= hops; h++) {
      const e = `tb_e${h}`;
      await c.query(`CREATE OR REPLACE TEMP TABLE ${e} AS
        SELECT ${h} AS hop, t.txn_id, t.sender, t.receiver, t.amount, t.ts, (t.receiver IN (SELECT acc FROM tb_visited)) AS cycle
        FROM txns t JOIN tb_frontier f ON t.sender = f.acc AND (t.ts IS NULL OR t.ts >= f.min_ts)
        WHERE t.receiver <> t.sender AND t.amount >= ${min}
        QUALIFY row_number() OVER (PARTITION BY t.sender ORDER BY t.amount DESC) <= ${cap}`);
      parts.push(`SELECT * FROM ${e}`);
      if (h === hops) break;
      await c.query(`CREATE OR REPLACE TEMP TABLE tb_frontier AS SELECT receiver AS acc, min(ts) AS min_ts FROM ${e} WHERE NOT cycle GROUP BY receiver`);
      await c.query(`INSERT INTO tb_visited SELECT acc FROM tb_frontier`);
    }
    const r = await this.query(`${parts.join(" UNION ALL ")} ORDER BY hop, ts`, 5000);
    return { ...r, ms: performance.now() - t0 };
  }

  async query(sql: string, limit = 1000): Promise<QueryResult> {
    if (!this.conn) throw new Error("DuckDB not ready");
    assertReadOnlySql(sql); // SQL console + benchmarks are strictly read-only, single-statement (see utils/sqlGuard.ts)
    const t0 = performance.now();
    const table = await this.conn.query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    const rows: unknown[][] = [];
    const n = table.numRows;
    for (let i = 0; i < Math.min(n, limit); i++) {
      const r = table.get(i);
      if (!r) continue;
      rows.push(columns.map((c) => {
        const v = (r as unknown as Record<string, unknown>)[c];
        if (typeof v === "bigint") return Number(v);
        if (v instanceof Date) return v.toISOString();
        if (v && typeof v === "object" && "toString" in v) return String(v);
        return v;
      }));
    }
    return { columns, rows, ms: performance.now() - t0, rowCount: n };
  }
}

export const duck = new DuckEngine();

/** SQL string literal with quotes doubled (identifiers/values from the UI are never concatenated raw). */
export function sqlStr(s: string): string { return "'" + String(s).replace(/'/g, "''") + "'"; }

/**
 * Single-statement 4-hop traceback (CTE chain) so it can be pasted into the SQL console and benchmarked.
 * `victimExpr` is a SQL expression (default: the account with the largest outgoing value).
 */
export function tracebackSql(victimExpr = "(SELECT sender FROM txns GROUP BY sender ORDER BY sum(amount) DESC LIMIT 1)", cap = 25): string {
  const hop = (n: number, prev: string) => `h${n} AS (
    SELECT ${n} AS hop, t.txn_id, t.sender, t.receiver, t.amount, t.ts
    FROM txns t JOIN (SELECT receiver AS acc, min(ts) AS min_ts FROM ${prev} GROUP BY receiver) f
      ON t.sender = f.acc AND (t.ts IS NULL OR t.ts >= f.min_ts)
    WHERE t.receiver <> t.sender
    QUALIFY row_number() OVER (PARTITION BY t.sender ORDER BY t.amount DESC) <= ${cap})`;
  return `WITH v AS (SELECT ${victimExpr} AS acc),
  h1 AS (
    SELECT 1 AS hop, t.txn_id, t.sender, t.receiver, t.amount, t.ts FROM txns t JOIN v ON t.sender = v.acc
    WHERE t.receiver <> t.sender
    QUALIFY row_number() OVER (PARTITION BY t.sender ORDER BY t.amount DESC) <= ${cap}),
  ${hop(2, "h1")}, ${hop(3, "h2")}, ${hop(4, "h3")}
SELECT hop, count(*) AS transfers, count(DISTINCT receiver) AS accounts, round(sum(amount), 2) AS amount
FROM (SELECT * FROM h1 UNION ALL SELECT * FROM h2 UNION ALL SELECT * FROM h3 UNION ALL SELECT * FROM h4) GROUP BY hop ORDER BY hop`;
}

export const BENCHMARK_QUERIES: { label: string; sql: string }[] = [
  { label: "Total records", sql: "SELECT count(*) AS records FROM txns" },
  { label: "Unique accounts", sql: "SELECT count(DISTINCT acc) AS unique_accounts FROM (SELECT sender AS acc FROM txns UNION ALL SELECT receiver FROM txns)" },
  { label: "Missing value matrix", sql: "SELECT count(*) - count(txn_id) AS txn_id_null, count(*) - count(sender) AS sender_null, count(*) - count(receiver) AS receiver_null, count(*) - count(amount) AS amount_null, count(*) - count(ts) AS ts_null, count(*) - count(mode) AS mode_null FROM txns" },
  { label: "Duplicate transaction IDs", sql: "SELECT count(*) - count(DISTINCT txn_id) AS duplicate_txn_ids FROM txns" },
  { label: "Top fan-in accounts", sql: "SELECT receiver, count(DISTINCT sender) AS unique_senders, count(*) AS inflows, sum(amount) AS total_in FROM txns GROUP BY receiver ORDER BY unique_senders DESC LIMIT 10" },
  { label: "4-hop traceback (clustered + indexed)", sql: tracebackSql() },
];
