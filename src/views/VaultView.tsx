import { useMemo } from "react";
import { Database, Timer, Grid3X3, CopyCheck, Layers } from "lucide-react";
import { useStore, fmtNum, fmtINR, fmtTs, fmtMs } from "@/store";
import { Panel, Stat, Badge, Bar, Th, Td } from "@/components/ui";
import { HIGH_RISK, MED_RISK } from "@/engine/analytics";

export function VaultView() {
  const { dataset, analytics, version, duckLoadMs, duckStatus, phase, loadDemo } = useStore();
  const riskDist = useMemo(() => {
    if (!analytics) return null;
    let high = 0, med = 0, low = 0, active = 0;
    for (let a = 0; a < analytics.nAcc; a++) {
      if (analytics.inCount[a] + analytics.outCount[a] === 0) continue;
      active++;
      const r = analytics.risk[a];
      if (r >= HIGH_RISK) high++; else if (r >= MED_RISK) med++; else low++;
    }
    return { high, med, low, active };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analytics, version]);

  if (!dataset || !analytics || !riskDist) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6">
        <div className="text-center">
          <div className="font-mono text-cyan-300 tracking-[0.4em] text-xs mb-3">OPERATION ABHEDYA-CHAKRA</div>
          <h1 className="text-3xl font-semibold text-slate-100">Profiling Vault is empty</h1>
          <p className="text-slate-400 mt-2 max-w-lg">Upload a transaction CSV (sender, receiver, amount, timestamp, mode) via the top bar, or load a synthetic range with planted mule rings to exercise all six investigation steps offline.</p>
        </div>
        <div className="flex gap-3">
          {[50000, 250000, 1000000].map((n) => (
            <button key={n} disabled={phase === "ingesting"} onClick={() => loadDemo(n)} className="glass rounded-xl px-6 py-4 hover:border-cyan-400/60 transition-colors text-left">
              <div className="font-mono text-2xl text-cyan-200">{(n / 1000).toFixed(0)}k</div>
              <div className="text-[10px] tracking-[0.2em] text-slate-500 uppercase">synthetic rows</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const p = dataset.profile;
  const timings = { ...dataset.timings, ...analytics.timings };
  if (duckStatus === "ready" && duckLoadMs > 0) timings["DuckDB table materialization"] = duckLoadMs;
  const totalMs = Object.values(dataset.timings).reduce((a, b) => a + b, 0) + Object.values(analytics.timings).reduce((a, b) => a + b, 0);
  const uniqueTxn = dataset.rowCount - p.duplicateTxnIds;
  const nCols = dataset.headers.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label="Total records" value={fmtNum(dataset.rowCount)} sub={`${(dataset.sizeBytes / 1048576).toFixed(1)} MB source`} accent="cyan" />
        <Stat label="Unique accounts" value={fmtNum(dataset.accounts.length)} sub={`${fmtNum(riskDist.active)} active nodes`} />
        <Stat label="Unique txn IDs" value={fmtNum(uniqueTxn)} sub={p.duplicateTxnIds ? `${fmtNum(p.duplicateTxnIds)} duplicates` : "no duplicates"} accent={p.duplicateTxnIds ? "amber" : "emerald"} />
        <Stat label="Total volume" value={fmtINR(p.amountSum)} sub={`mean ${fmtINR(p.amountMean)}`} />
        <Stat label="High-risk accounts" value={fmtNum(riskDist.high)} sub={`${fmtNum(riskDist.med)} medium · ${fmtNum(riskDist.low)} low`} accent="red" />
        <Stat label="Pipeline time" value={fmtMs(totalMs)} sub={totalMs < 60000 ? "✓ within 60s target" : "⚠ exceeded 60s target"} accent={totalMs < 60000 ? "emerald" : "amber"} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Missing value matrix" icon={<Grid3X3 size={13} />} className="xl:col-span-2">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-2.5">
              {p.columns.map((c) => (
                <div key={c.name}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-mono text-slate-200 flex items-center gap-2">{c.name} {c.mapped && <Badge tone="cyan" className="shadow-none">{c.mapped}</Badge>}</span>
                    <span className={"font-mono " + (c.nulls ? "text-amber-300" : "text-emerald-300")}>{fmtNum(c.nulls)} · {c.nullPct.toFixed(2)}%</span>
                  </div>
                  <Bar value={Math.max(c.nullPct, c.nulls ? 1.5 : 0)} color={c.nullPct > 5 ? "#ef4444" : c.nulls ? "#f59e0b" : "#10b981"} height={4} />
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">Row × column nullity (first {p.missingMatrixRows} records)</div>
              <div className="overflow-hidden rounded border border-cyan-500/15 bg-black/40 p-1">
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${nCols}, minmax(0, 1fr))` }}>
                  {Array.from({ length: p.missingMatrixRows * nCols }, (_, i) => (
                    <div key={i} className="h-[3px]" style={{ background: p.missingMatrix[i] ? "#ef4444" : "rgba(6,182,212,0.35)" }} />
                  ))}
                </div>
              </div>
              <div className="flex gap-3 mt-2 text-[10px] font-mono text-slate-500"><span><span className="inline-block w-2 h-2 bg-cyan-500/60 mr-1" />present</span><span><span className="inline-block w-2 h-2 bg-red-500 mr-1" />missing</span></div>
            </div>
          </div>
        </Panel>

        <Panel title="Integrity checks" icon={<CopyCheck size={13} />}>
          <ul className="space-y-2.5 text-xs">
            <Check label="Duplicate transaction IDs" value={p.duplicateTxnIds} />
            <Check label="Exact duplicate rows (sender, receiver, amount, ts)" value={p.duplicateFullRows} />
            <Check label="Invalid / non-numeric amounts" value={p.invalidAmounts} />
            <Check label="Unparseable timestamps" value={p.invalidTimestamps} />
            <Check label="Self-transfers (sender = receiver)" value={p.selfTransfers} />
          </ul>
          <div className="mt-4 pt-3 border-t border-cyan-500/10 grid grid-cols-2 gap-2 text-[11px] font-mono">
            <div><div className="text-slate-500">Time range</div><div className="text-slate-200">{fmtTs(p.tsMin)}</div><div className="text-slate-200">{fmtTs(p.tsMax)}</div></div>
            <div><div className="text-slate-500">Amount range</div><div className="text-slate-200">{fmtINR(p.amountMin)}</div><div className="text-slate-200">{fmtINR(p.amountMax)}</div></div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Benchmark timings" icon={<Timer size={13} />} className="xl:col-span-1">
          <table className="w-full">
            <thead><tr><Th>Stage</Th><Th className="text-right">Time</Th></tr></thead>
            <tbody>
              {Object.entries(timings).map(([k, v]) => (
                <tr key={k}><Td mono={false} className="text-slate-300">{k}</Td><Td className="text-right text-cyan-200">{fmtMs(v)}</Td></tr>
              ))}
              <tr><Td mono={false} className="text-slate-100 font-semibold">End-to-end (excluding DuckDB)</Td><Td className={"text-right font-semibold " + (totalMs < 60000 ? "text-emerald-300" : "text-amber-300")}>{fmtMs(totalMs)}</Td></tr>
            </tbody>
          </table>
          <div className="mt-3 text-[11px] text-slate-500">Target: &lt; 60 s for 2M rows. Throughput ≈ <span className="font-mono text-cyan-300">{fmtNum(Math.round(dataset.rowCount / Math.max(0.001, totalMs / 1000)))}</span> rows/s on this machine.</div>
        </Panel>
        <Panel title="Payment mode distribution" icon={<Layers size={13} />}>
          <div className="space-y-2">
            {p.modeDistribution.slice(0, 10).map((m) => (
              <div key={m.mode}>
                <div className="flex justify-between text-xs mb-1"><span className="font-mono text-slate-200">{m.mode}</span><span className="font-mono text-slate-400">{fmtNum(m.count)} · {((m.count / dataset.rowCount) * 100).toFixed(1)}%</span></div>
                <Bar value={(m.count / dataset.rowCount) * 100} height={4} />
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Normalized schema" icon={<Database size={13} />}>
          <table className="w-full">
            <thead><tr><Th>Field</Th><Th>Source column</Th><Th>Storage</Th></tr></thead>
            <tbody>
              {([["txnId", "string[]"], ["sender", "Int32Array → dict"], ["receiver", "Int32Array → dict"], ["amount", "Float64Array"], ["timestamp", "Float64Array (epoch ms)"], ["mode", "Uint16Array → dict"]] as const).map(([k, st]) => (
                <tr key={k}><Td className="text-cyan-200">{k}</Td><Td className="text-slate-200">{dataset.mapping[k] >= 0 ? dataset.headers[dataset.mapping[k]] : <span className="text-slate-600">—</span>}</Td><Td className="text-slate-500">{st}</Td></tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-[11px] text-slate-500">Raw CSV lines retained: <span className="font-mono text-cyan-300">{fmtNum(dataset.rawRetained)}</span> / {fmtNum(dataset.rowCount)}</div>
        </Panel>
      </div>
    </div>
  );
}

function Check({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-slate-300">{label}</span>
      <Badge tone={value === 0 ? "emerald" : value > 1000 ? "red" : "amber"} className={value > 1000 ? "" : "shadow-none"}>{fmtNum(value)}</Badge>
    </li>
  );
}
