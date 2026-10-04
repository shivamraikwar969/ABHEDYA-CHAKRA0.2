import { useState } from "react";
import { Terminal, Play, Zap } from "lucide-react";
import { useStore, fmtMs, fmtNum } from "@/store";
import { Panel, Button, Empty, Badge, Th, Td } from "@/components/ui";
import { duck, BENCHMARK_QUERIES, type QueryResult } from "@/engine/duckdb";

export function SqlView() {
  const { dataset, duckStatus, duckTableLoaded, duckLoadMs } = useStore();
  const [sql, setSql] = useState("SELECT receiver, count(DISTINCT sender) AS unique_senders, count(*) AS inflows, round(sum(amount)) AS total_in\nFROM txns GROUP BY receiver ORDER BY unique_senders DESC LIMIT 25");
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bench, setBench] = useState<{ label: string; ms: number; rows: number; preview: string }[]>([]);

  const run = async (q = sql) => {
    setBusy(true); setErr(null);
    try { setRes(await duck.query(q, 500)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setRes(null); }
    setBusy(false);
  };
  const runBench = async () => {
    setBusy(true); const out: typeof bench = [];
    for (const b of BENCHMARK_QUERIES) {
      try { const r = await duck.query(b.sql, 10); out.push({ label: b.label, ms: r.ms, rows: r.rowCount, preview: r.rows[0] ? r.rows[0].map((v) => String(v)).join(" · ").slice(0, 80) : "" }); }
      catch (e) { out.push({ label: b.label, ms: 0, rows: 0, preview: "ERROR " + (e instanceof Error ? e.message : String(e)) }); }
      setBench([...out]);
    }
    setBusy(false);
  };

  if (duckStatus !== "ready") {
    return (
      <Empty title={duckStatus === "loading" ? "DuckDB-WASM initializing…" : "DuckDB-WASM unavailable"}>
        {duckStatus === "loading" ? "Fetching the DuckDB engine bundle. The embedded SETU-Columnar engine is already serving all analytics." : (
          <>The DuckDB-WASM runtime could not be loaded in this environment ({duck.error || "offline"}). All profiling, graph, scoring and trail modules continue to run on the embedded offline columnar engine. Reconnect and reload to enable the SQL console.</>
        )}
      </Empty>
    );
  }
  if (!dataset) return <Empty title="No dataset loaded">Ingest a CSV; it will be materialized as table <span className="font-mono text-cyan-300">txns</span> inside DuckDB.</Empty>;
  if (!duckTableLoaded) return <Empty title="Materializing table in DuckDB…">Loading {fmtNum(dataset.rowCount)} rows into DuckDB via read_csv.</Empty>;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <div className="xl:col-span-2 space-y-4">
        <Panel title="SQL console · table txns (txn_id, sender, receiver, amount, ts, mode)" icon={<Terminal size={13} />} actions={<Badge tone="emerald">DuckDB {duck.version}</Badge>}>
          <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} rows={6}
            className="w-full bg-black/50 border border-cyan-500/20 focus:border-cyan-400/70 focus:outline-none rounded-lg p-3 font-mono text-xs text-emerald-200 resize-y"
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); }} />
          <div className="flex items-center gap-2 mt-2">
            <Button onClick={() => run()} disabled={busy}><Play size={12} className="inline mr-1" /> Run (Ctrl+Enter)</Button>
            {res && <span className="text-[11px] font-mono text-slate-400">{fmtNum(res.rowCount)} rows · {fmtMs(res.ms)}{res.rowCount > res.rows.length && ` · showing ${res.rows.length}`}</span>}
          </div>
          {err && <div className="mt-2 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 whitespace-pre-wrap">{err}</div>}
        </Panel>
        {res && (
          <Panel title="Result set" className="[&>div:last-child]:p-0">
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-[#060b18]"><tr>{res.columns.map((c) => <Th key={c}>{c}</Th>)}</tr></thead>
                <tbody>{res.rows.map((r, i) => <tr key={i} className="hover:bg-cyan-500/5">{r.map((v, j) => <Td key={j} className="text-slate-200">{v === null || v === undefined ? <span className="text-slate-600">NULL</span> : typeof v === "number" ? v.toLocaleString("en-IN") : String(v)}</Td>)}</tr>)}</tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
      <div className="space-y-4">
        <Panel title="DuckDB benchmark" icon={<Zap size={13} />} actions={<Button onClick={runBench} disabled={busy}>Run suite</Button>}>
          <div className="text-[11px] font-mono text-slate-500 mb-3">Table load: <span className="text-cyan-300">{fmtMs(duckLoadMs)}</span> for {fmtNum(dataset.rowCount)} rows</div>
          <table className="w-full">
            <thead><tr><Th>Query</Th><Th className="text-right">Time</Th></tr></thead>
            <tbody>
              {bench.map((b) => (
                <tr key={b.label}><Td mono={false}><div className="text-slate-200">{b.label}</div><div className="text-[10px] font-mono text-slate-500 truncate max-w-[220px]">{b.preview}</div></Td><Td className="text-right text-cyan-200">{fmtMs(b.ms)}</Td></tr>
              ))}
              {bench.length === 0 && <tr><Td mono={false} className="text-slate-500">Run the suite to time count / distinct / null-matrix / duplicate queries.</Td></tr>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Saved queries">
          <div className="space-y-1.5">
            {BENCHMARK_QUERIES.concat([
              { label: "Rapid pass-through pairs", sql: "SELECT a.receiver AS mule, a.txn_id AS in_txn, b.txn_id AS out_txn, a.amount AS in_amt, b.amount AS out_amt, date_diff('minute', a.ts, b.ts) AS minutes\nFROM txns a JOIN txns b ON a.receiver = b.sender AND b.ts >= a.ts AND b.ts <= a.ts + INTERVAL 30 MINUTE AND b.amount >= 0.8*a.amount\nLIMIT 50" },
              { label: "Structured amounts (just under ₹50k)", sql: "SELECT * FROM txns WHERE amount >= 45000 AND amount < 50000 ORDER BY ts LIMIT 100" },
              { label: "Hourly velocity peaks", sql: "SELECT receiver, date_trunc('hour', ts) AS hr, count(*) AS n FROM txns GROUP BY 1,2 ORDER BY n DESC LIMIT 25" },
            ]).map((q) => (
              <button key={q.label} onClick={() => { setSql(q.sql); run(q.sql); }} className="w-full text-left px-3 py-2 rounded border border-slate-800 hover:border-cyan-400/40 text-xs text-slate-300 hover:text-cyan-200">{q.label}</button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
