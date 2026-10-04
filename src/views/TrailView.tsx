import { useEffect, useMemo, useState } from "react";
import { Route, Download, Play, Repeat, AlertOctagon } from "lucide-react";
import { useStore, fmtINR, fmtNum, fmtTs, fmtMs } from "@/store";
import { Panel, Button, Input, Empty, Badge, RiskBadge, LayerBadge, Stat, Th, Td } from "@/components/ui";
import { TxnLink, AccountLink } from "@/components/Evidence";
import { traceTrail, trailToCSV, DEFAULT_TRAIL_OPTIONS, type TrailOptions } from "@/engine/trail";
import { ForceGraph, type GEdge, type GNode } from "@/components/ForceGraph";
import { LAYER_LABELS, type TrailResult } from "@/engine/types";
import { ExitPanel, HowToRead } from "@/components/ExitFlow";
import { computeExits, leafTags } from "@/engine/exits";

export function TrailView() {
  const { dataset, analytics, version, trailTarget, setTrailTarget, demoHints, openEvidence, selectAccount } = useStore();
  const [victim, setVictim] = useState(trailTarget ?? "");
  const [opts, setOpts] = useState<TrailOptions>(DEFAULT_TRAIL_OPTIONS);
  const [result, setResult] = useState<TrailResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hopFilter, setHopFilter] = useState<number>(0);

  useEffect(() => { if (trailTarget) { setVictim(trailTarget); setTrailTarget(null); } }, [trailTarget, setTrailTarget]);

  const run = (id?: string) => {
    if (!dataset || !analytics) return;
    const v = (id ?? victim).trim();
    if (!v) { setErr("Enter a victim account ID."); setResult(null); return; }
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) {
      const sugg = dataset.accounts.filter((a) => a.toLowerCase().includes(v.toLowerCase())).slice(0, 4);
      setErr(`Account "${v}" does not exist in the loaded dataset.${sugg.length ? " Similar IDs: " + sugg.join(", ") : ""}`);
      setResult(null); return;
    }
    if (analytics.outCount[idx] === 0) { setErr(`Account "${v}" has no outbound transactions — nothing to trace. (${analytics.inCount[idx]} inbound found.)`); setResult(null); return; }
    setErr(null);
    setResult(traceTrail(dataset, analytics, idx, opts));
    setHopFilter(0);
  };

  // re-run when weights change so layer/risk labels stay in sync
  useEffect(() => { if (result && dataset && analytics) setResult(traceTrail(dataset, analytics, result.victim, opts)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [version]);

  const graph = useMemo(() => {
    if (!dataset || !analytics || !result) return null;
    const nodeMap = new Map<number, GNode>();
    const mk = (a: number) => { if (!nodeMap.has(a)) nodeMap.set(a, { id: a, label: dataset.accounts[a], risk: analytics.risk[a], degree: analytics.inCount[a] + analytics.outCount[a], layer: analytics.layer[a] }); };
    const edges: GEdge[] = result.edges.slice(0, 600).map((e) => { mk(e.sender); mk(e.receiver); return { source: e.sender, target: e.receiver, row: e.row, txnId: e.txnId, amount: e.amount, ts: e.ts, flagged: e.cycle || e.risk >= 70, hop: e.hop } as GEdge; });
    return { nodes: Array.from(nodeMap.values()), edges };
  }, [dataset, analytics, result]);

  const exits = useMemo(() => (dataset && analytics && result ? computeExits(dataset, analytics, result.edges.map((e) => e.row), null) : null), [dataset, analytics, result]);
  const tags = useMemo(() => (exits ? leafTags(exits) : undefined), [exits]);

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest a CSV to trace victim money trails.</Empty>;

  const rows = result ? (hopFilter ? result.edges.filter((e) => e.hop === hopFilter) : result.edges) : [];
  const download = () => {
    if (!result) return;
    const blob = new Blob([trailToCSV(dataset, result, LAYER_LABELS)], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `setu_trail_${dataset.accounts[result.victim]}.csv`; a.click();
  };

  return (
    <div className="space-y-4">
      <Panel title="Victim account input" icon={<Route size={13} />} strong>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[260px]">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">Victim account ID (any valid account)</div>
            <Input value={victim} onChange={setVictim} placeholder="e.g. VIC00000001" className="w-full" onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
          </div>
          <Opt label="Max hops (≤4)"><Input value={String(opts.maxHops)} onChange={(v) => setOpts({ ...opts, maxHops: Math.min(4, Math.max(1, Number(v) || 1)) })} className="w-20" /></Opt>
          <Opt label="Branch cap / node"><Input value={String(opts.branchCap)} onChange={(v) => setOpts({ ...opts, branchCap: Math.max(1, Number(v) || 1) })} className="w-24" /></Opt>
          <Opt label="Min amount ₹"><Input value={String(opts.minAmount)} onChange={(v) => setOpts({ ...opts, minAmount: Number(v) || 0 })} className="w-28" /></Opt>
          <Opt label="Chronological">
            <Button variant={opts.chronological ? "toggle-on" : "toggle-off"} onClick={() => setOpts({ ...opts, chronological: !opts.chronological })}>{opts.chronological ? "ON" : "OFF"}</Button>
          </Opt>
          <Button onClick={() => run()} className="h-[34px] px-5"><Play size={12} className="inline mr-1" /> Trace</Button>
        </div>
        {demoHints && (
          <div className="mt-3 text-[11px] font-mono text-slate-500 flex flex-wrap gap-1 items-center">
            <span className="mr-1">Synthetic victims:</span>
            {demoHints.victims.slice(0, 8).map((v) => <button key={v} onClick={() => { setVictim(v); run(v); }} className="px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10">{v}</button>)}
          </div>
        )}
        {err && <div className="mt-3 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 flex items-center gap-2"><AlertOctagon size={14} /> {err}</div>}
      </Panel>

      <HowToRead context="trail" />

      {result && graph && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <Stat label="Victim" value={<span className="text-sm break-all">{dataset.accounts[result.victim]}</span>} accent="cyan" />
            <Stat label="Traced edges" value={fmtNum(result.edges.length)} sub={result.truncated ? "bounded (caps hit)" : "complete within bounds"} accent={result.truncated ? "amber" : "emerald"} />
            <Stat label="Accounts reached" value={fmtNum(result.accountsVisited - 1)} />
            <Stat label="Cycle-backs" value={fmtNum(result.cyclesDetected)} accent={result.cyclesDetected ? "red" : undefined} />
            <Stat label="Traced volume" value={fmtINR(result.totalAmount)} />
            <Stat label="Hop distribution" value={<span className="text-sm">{[1, 2, 3, 4].map((h) => result.hopCounts[h]).join(" / ")}</span>} sub="H1 / H2 / H3 / H4" />
            <Stat label="BFS time" value={fmtMs(result.ms)} accent="emerald" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
            <div className="xl:col-span-2 glass rounded-xl p-1 min-h-[380px]">
              <ForceGraph nodes={graph.nodes} edges={graph.edges} showTxnIds={false} showAmounts={graph.edges.length <= 120} highlight={result.victim} leafInfo={tags} onNodeClick={(id) => selectAccount(id, true)} onEdgeClick={openEvidence} />
            </div>
            <Panel className="xl:col-span-3 [&>div:last-child]:p-0" title="Traced ledger" icon={<Repeat size={13} />}
              actions={<>
                {[0, 1, 2, 3, 4].map((h) => <Button key={h} variant={hopFilter === h ? "toggle-on" : "toggle-off"} onClick={() => setHopFilter(h)} className="px-2 py-1">{h === 0 ? "All" : `Hop ${h}`}</Button>)}
                <Button variant="ghost" onClick={download}><Download size={12} /></Button>
              </>}>
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-[#060b18] z-10"><tr><Th>Hop</Th><Th>Sender</Th><Th>Receiver</Th><Th className="text-right">Amount</Th><Th>Timestamp</Th><Th>Txn ID</Th><Th>Layer</Th><Th>Risk</Th></tr></thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.row + "-" + e.hop} className={"hover:bg-cyan-500/5 " + (e.cycle ? "bg-red-500/5" : "")}>
                        <Td><Badge tone={e.hop === 1 ? "cyan" : e.hop === 2 ? "emerald" : e.hop === 3 ? "amber" : "red"} className="shadow-none">H{e.hop}</Badge>{e.cycle && <Badge tone="red" className="ml-1">CYCLE</Badge>}</Td>
                        <Td><AccountLink acc={e.sender} /></Td>
                        <Td><AccountLink acc={e.receiver} /></Td>
                        <Td className="text-right text-slate-100">{fmtINR(e.amount)}</Td>
                        <Td className="text-slate-400">{fmtTs(e.ts)}</Td>
                        <Td><TxnLink row={e.row} /></Td>
                        <Td><LayerBadge layer={e.layer} /></Td>
                        <Td><RiskBadge risk={e.risk} /></Td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><Td mono={false} className="text-slate-500 py-6 text-center" >No edges at this hop.</Td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          {exits && <ExitPanel ex={exits} ds={dataset} cur={null} onPick={(a) => selectAccount(a, true)} />}
          <div className="text-[11px] text-slate-500 font-mono px-1">BFS expands each account at most once (cycle detection); edges that return to an already-visited account are listed as CYCLE and not expanded. Chronological mode only follows outflows timestamped at/after the inbound transfer. Layer = classification of the receiving account.</div>
        </>
      )}
      {!result && !err && <Empty title="Awaiting victim account">Enter a victim account ID and press Trace to run a bounded breadth-first traversal (Hop 1 → Hop 4) with cycle detection and multi-branch handling.</Empty>}
    </div>
  );
}

function Opt({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">{label}</div>{children}</div>;
}
