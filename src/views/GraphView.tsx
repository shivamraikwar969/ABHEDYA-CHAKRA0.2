import { useEffect, useMemo, useState } from "react";
import { GitBranch, Filter, Clock, AlertTriangle, Crosshair } from "lucide-react";
import { useStore, fmtINR, fmtTs, fmtNum } from "@/store";
import { ForceGraph } from "@/components/ForceGraph";
import { Panel, Button, Input, Select, Badge, Empty, RiskBadge, LayerBadge, Th, Td } from "@/components/ui";
import { TxnLink, AccountLink } from "@/components/Evidence";
import { buildEgo, buildFiltered, buildFlagged, buildFull, chronoTree, type ChronoNode } from "@/engine/graph";
import { topAccounts } from "@/engine/analytics";
import { FLAG_LABELS } from "@/engine/types";

type Mode = "full" | "flagged" | "account";

export function GraphView() {
  const { dataset, analytics, version, selectedAccount, selectAccount, openEvidence } = useStore();
  const [mode, setMode] = useState<Mode>(selectedAccount !== null ? "account" : "full");
  const [showIds, setShowIds] = useState(true);
  const [showAmounts, setShowAmounts] = useState(true);
  const [txnQ, setTxnQ] = useState("");
  const [accQ, setAccQ] = useState("");
  const [modeQ, setModeQ] = useState("");
  const [minAmt, setMinAmt] = useState("");
  const [accPick, setAccPick] = useState("");

  useEffect(() => { if (selectedAccount !== null) setMode("account"); }, [selectedAccount]);

  const options = useMemo(() => {
    if (!dataset || !analytics) return [];
    return topAccounts(analytics, 300, 1).map((a) => ({ value: String(a), label: `${dataset.accounts[a]} · risk ${analytics.risk[a]}` }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, analytics, version]);

  const filtersActive = !!(txnQ.trim() || accQ.trim() || modeQ || Number(minAmt) > 0);

  const graph = useMemo(() => {
    if (!dataset || !analytics) return null;
    if (filtersActive) return buildFiltered(dataset, analytics, { txnId: txnQ, account: accQ, mode: modeQ, minAmount: Number(minAmt) || 0 });
    if (mode === "flagged") return { ...buildFlagged(dataset, analytics), matches: analytics.flaggedRows.length };
    if (mode === "account" && selectedAccount !== null) { const g = buildEgo(dataset, analytics, selectedAccount); return { ...g, matches: g.edges.length }; }
    const g = buildFull(dataset, analytics); return { ...g, matches: dataset.rowCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, analytics, version, mode, selectedAccount, filtersActive, txnQ, accQ, modeQ, minAmt]);

  const tree = useMemo(() => (dataset && analytics && mode === "account" && selectedAccount !== null && !filtersActive ? chronoTree(dataset, analytics, selectedAccount) : null), [dataset, analytics, mode, selectedAccount, filtersActive, version]);

  if (!dataset || !analytics || !graph) return <Empty title="No dataset loaded">Ingest a CSV to render the transaction network.</Empty>;

  const resolveAccount = (s: string) => {
    const v = s.trim();
    if (!v) return;
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) { setAccQ(v); return; }
    setTxnQ(""); setAccQ(""); selectAccount(idx); setMode("account");
  };

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="glass rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
        <Button variant={mode === "full" && !filtersActive ? "toggle-on" : "toggle-off"} onClick={() => { setMode("full"); }}>[ Show full tree ]</Button>
        <Button variant={mode === "flagged" && !filtersActive ? "toggle-on" : "toggle-off"} onClick={() => setMode("flagged")}>[ Malicious / flagged txns with IDs ]</Button>
        <Button variant={mode === "account" && !filtersActive ? "toggle-on" : "toggle-off"} onClick={() => setMode("account")} disabled={selectedAccount === null}>[ Account-specific tree ]</Button>
        <div className="h-5 w-px bg-cyan-500/20 mx-1" />
        <Select value={accPick} onChange={(v) => { setAccPick(v); if (v) { selectAccount(Number(v)); setMode("account"); setTxnQ(""); setAccQ(""); } }} className="max-w-[260px] text-xs" options={[{ value: "", label: "— isolate account (top risk) —" }, ...options]} />
        <Input value={accQ} onChange={setAccQ} placeholder="Account ID (exact → isolate, partial → filter)" className="w-72 text-xs" onKeyDown={(e) => { if (e.key === "Enter") resolveAccount(accQ); }} />
        <Button variant="ghost" onClick={() => resolveAccount(accQ)}><Crosshair size={12} /></Button>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400"><input type="checkbox" checked={showAmounts} onChange={(e) => setShowAmounts(e.target.checked)} className="accent-cyan-400" /> amounts</label>
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400"><input type="checkbox" checked={showIds} onChange={(e) => setShowIds(e.target.checked)} className="accent-cyan-400" /> txn IDs on flagged</label>
      </div>

      <div className="glass rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500 flex items-center gap-1"><Filter size={11} /> Filters</span>
        <Input value={txnQ} onChange={setTxnQ} placeholder="Transaction ID contains…" className="w-56 text-xs" />
        <Select value={modeQ} onChange={setModeQ} className="text-xs" options={[{ value: "", label: "All payment modes" }, ...dataset.modes.map((m) => ({ value: m, label: m }))]} />
        <Input value={minAmt} onChange={setMinAmt} placeholder="Min amount ₹" className="w-32 text-xs" />
        {filtersActive && <Button variant="danger" onClick={() => { setTxnQ(""); setAccQ(""); setModeQ(""); setMinAmt(""); }}>Clear</Button>}
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-slate-400">
          {filtersActive ? <>{fmtNum(graph.matches)} matching · showing {graph.edges.length}</> : mode === "flagged" ? <>{fmtNum(analytics.flaggedRows.length)} flagged · showing {graph.edges.length}</> : mode === "account" ? <>ego network · {graph.edges.length} edges</> : <>top-risk overview · {graph.nodes.length} of {fmtNum(dataset.accounts.length)} accounts</>}
          {graph.truncated && <Badge tone="amber" className="ml-2 shadow-none">BOUNDED</Badge>}
        </span>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 glass rounded-xl p-1 min-h-[420px]">
          {graph.edges.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm font-mono">No transactions match the current selection.</div>
          ) : (
            <ForceGraph nodes={graph.nodes} edges={graph.edges} showTxnIds={showIds} showAmounts={showAmounts} highlight={selectedAccount}
              onNodeClick={(id) => { selectAccount(id); setMode("account"); setTxnQ(""); setAccQ(""); }} onEdgeClick={(row) => openEvidence(row)} />
          )}
        </div>
        <div className="min-h-0 flex flex-col gap-3 overflow-hidden">
          {mode === "account" && selectedAccount !== null && tree && !filtersActive ? (
            <Panel title={<>Chronological outflow tree</>} icon={<Clock size={13} />} className="flex-1 min-h-0 flex flex-col [&>div:last-child]:overflow-y-auto [&>div:last-child]:flex-1" actions={<Button variant="ghost" onClick={() => selectAccount(selectedAccount, true)}>Risk profile</Button>}>
              <div className="font-mono text-xs text-cyan-200 mb-2 flex items-center gap-2 flex-wrap"><GitBranch size={12} /> {dataset.accounts[selectedAccount]} <RiskBadge risk={analytics.risk[selectedAccount]} /><LayerBadge layer={analytics.layer[selectedAccount]} /></div>
              {tree.inflows.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">Inflows ({analytics.inCount[selectedAccount]})</div>
                  {tree.inflows.slice(0, 12).map((r) => (
                    <div key={r} className="font-mono text-[11px] text-slate-400 flex gap-2 py-0.5"><span className="text-slate-600">{fmtTs(dataset.ts[r])}</span><AccountLink acc={dataset.sender[r]} className="text-slate-300" /><span className="text-emerald-300 ml-auto">+{fmtINR(dataset.amount[r])}</span></div>
                  ))}
                </div>
              )}
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">Outflows → downstream (time-consistent, max depth 3)</div>
              {tree.roots.length === 0 && <div className="text-xs text-slate-500">No outflows from this account.</div>}
              {tree.roots.map((n) => <TreeRow key={n.row} node={n} />)}
            </Panel>
          ) : (
            <Panel title={mode === "flagged" || filtersActive ? "Transaction ledger" : "Flagged transactions"} icon={<AlertTriangle size={13} />} className="flex-1 min-h-0 flex flex-col [&>div:last-child]:overflow-auto [&>div:last-child]:flex-1 [&>div:last-child]:p-0">
              <table className="w-full">
                <thead className="sticky top-0 bg-[#060b18]"><tr><Th>Txn ID</Th><Th>Sender → Receiver</Th><Th className="text-right">Amount</Th><Th>Flags</Th></tr></thead>
                <tbody>
                  {(mode === "flagged" || filtersActive ? graph.edges : graph.edges.filter((e) => e.flagged)).slice(0, 200).map((e) => (
                    <tr key={e.row} className="hover:bg-cyan-500/5">
                      <Td><TxnLink row={e.row} /></Td>
                      <Td className="text-slate-300 max-w-[200px] truncate">{dataset.accounts[dataset.sender[e.row]]} → {dataset.accounts[dataset.receiver[e.row]]}</Td>
                      <Td className="text-right text-slate-100">{fmtINR(e.amount)}</Td>
                      <Td><div className="flex gap-1 flex-wrap">{Object.keys(FLAG_LABELS).map(Number).filter((f) => analytics.txnFlags[e.row] & f).map((f) => <Badge key={f} tone="red" className="shadow-none">{FLAG_LABELS[f]}</Badge>)}</div></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeRow({ node }: { node: ChronoNode }) {
  const { dataset, analytics } = useStore();
  if (!dataset || !analytics) return null;
  const r = node.row;
  const to = dataset.receiver[r];
  return (
    <div style={{ marginLeft: (node.depth - 1) * 14 }} className="border-l border-cyan-500/20 pl-2 py-0.5">
      <div className="font-mono text-[11px] flex items-center gap-2 flex-wrap">
        <span className="text-slate-600">{fmtTs(dataset.ts[r])}</span>
        <span className="text-cyan-400">→</span>
        <AccountLink acc={to} />
        <span className="text-slate-100">{fmtINR(dataset.amount[r])}</span>
        <TxnLink row={r} className="text-[10px] text-slate-500" />
        {analytics.risk[to] >= 70 && <Badge tone="red" className="shadow-none">{analytics.risk[to]}</Badge>}
      </div>
      {node.children.map((c) => <TreeRow key={c.row} node={c} />)}
    </div>
  );
}
