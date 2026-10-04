import { useMemo, useState } from "react";
import { Radar, SlidersHorizontal, ListTree, Trophy, RotateCcw } from "lucide-react";
import { useStore, fmtINR, fmtNum, fmtTs } from "@/store";
import { Panel, Gauge, Bar, Button, Input, Empty, RiskBadge, LayerBadge, Badge, Th, Td } from "@/components/ui";
import { TxnLink, AccountLink } from "@/components/Evidence";
import { breakdown, topAccounts, riskColor } from "@/engine/analytics";
import { DEFAULT_WEIGHTS, type Weights } from "@/engine/types";

const WLABELS: { key: keyof Weights; label: string }[] = [
  { key: "velocity", label: "Velocity" }, { key: "l1", label: "L1 Collector" }, { key: "l2", label: "L2 Distributor" }, { key: "l3", label: "L3 Indicators" }, { key: "centrality", label: "Network Centrality" },
];

export function RiskView() {
  const { dataset, analytics, version, weights, setWeights, selectedAccount, selectAccount, setTrailTarget, setView } = useStore();
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [openComp, setOpenComp] = useState<string | null>("l3");

  const leaderboard = useMemo(() => (analytics ? topAccounts(analytics, 40, 1) : []), [analytics, version]);
  const bd = useMemo(() => (dataset && analytics && selectedAccount !== null ? breakdown(dataset, analytics, selectedAccount, weights) : null), [dataset, analytics, selectedAccount, weights, version]);

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest a CSV to compute Mule Risk Index scores.</Empty>;

  const lookup = () => {
    const v = query.trim();
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) {
      const sugg = dataset.accounts.filter((a) => a.toLowerCase().includes(v.toLowerCase())).slice(0, 3);
      setErr(`Account "${v}" not found in dataset.${sugg.length ? " Did you mean: " + sugg.join(", ") : ""}`);
      return;
    }
    setErr(null); selectAccount(idx);
  };
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  const a = selectedAccount;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <div className="xl:col-span-2 space-y-4">
        <Panel title="Account lookup" icon={<Radar size={13} />}>
          <div className="flex gap-2">
            <Input value={query} onChange={setQuery} list="acc-list" placeholder="Enter any account ID…" className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") lookup(); }} />
            <datalist id="acc-list">{leaderboard.map((x) => <option key={x} value={dataset.accounts[x]} />)}</datalist>
            <Button onClick={lookup}>Score</Button>
          </div>
          {err && <div className="mt-2 text-xs text-red-300 font-mono border border-red-500/40 bg-red-500/10 rounded px-3 py-2">{err}</div>}
        </Panel>

        {a === null || !bd ? (
          <Empty title="Select an account">Pick an account from the leaderboard or enter an ID to see its transparent 0–100 Mule Risk Index with full evidence traceability.</Empty>
        ) : (
          <>
            <Panel strong title={<>Mule Risk Index · <span className="text-slate-100 normal-case tracking-normal">{dataset.accounts[a]}</span></>} icon={<Radar size={13} />}
              actions={<><Button variant="ghost" onClick={() => { setView("graph"); }}>Isolate in graph</Button><Button variant="ghost" onClick={() => { setTrailTarget(dataset.accounts[a]); setView("trail"); }}>Trace 4-hop trail</Button></>}>
              <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-center">
                <div className="flex flex-col items-center gap-2">
                  <Gauge value={analytics.risk[a]} size={220} />
                  <div className="flex gap-2 flex-wrap justify-center"><RiskBadge risk={analytics.risk[a]} /><LayerBadge layer={analytics.layer[a]} /></div>
                </div>
                <div className="space-y-3">
                  {bd.map((c) => (
                    <div key={c.key}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-slate-200 font-medium">{c.label} <span className="text-slate-500 font-mono">· w{c.weight}</span></span>
                        <span className="font-mono text-cyan-200">{c.points.toFixed(1)} <span className="text-slate-500">/ {((c.weight / totalW) * 100).toFixed(0)}</span></span>
                      </div>
                      <Bar value={c.value * 100} color={riskColor(c.value * 100)} />
                    </div>
                  ))}
                  <div className="grid grid-cols-4 gap-2 pt-2 text-[11px] font-mono">
                    <Mini l="Inflows" v={`${fmtNum(analytics.inCount[a])} / ${fmtNum(analytics.uniqueIn[a])} src`} />
                    <Mini l="Outflows" v={`${fmtNum(analytics.outCount[a])} / ${fmtNum(analytics.uniqueOut[a])} dst`} />
                    <Mini l="Volume in" v={fmtINR(analytics.inSum[a])} />
                    <Mini l="Volume out" v={fmtINR(analytics.outSum[a])} />
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Component breakdown & evidence chain" icon={<ListTree size={13} />}>
              <div className="text-[11px] text-slate-500 mb-3 font-mono">Risk Score → Component → Evidence Type → Transaction ID → Original CSV Record. Click any transaction ID to open the source record.</div>
              <div className="space-y-2">
                {bd.map((c) => (
                  <div key={c.key} className="border border-cyan-500/15 rounded-lg overflow-hidden">
                    <button onClick={() => setOpenComp(openComp === c.key ? null : c.key)} className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-900/40 hover:bg-slate-900/70 text-left">
                      <span className="text-sm text-slate-100">{c.label}</span>
                      <span className="font-mono text-xs" style={{ color: riskColor(c.value * 100) }}>{(c.value * 100).toFixed(0)}% × {c.weight} → {c.points.toFixed(1)} pts</span>
                    </button>
                    {openComp === c.key && (
                      <div className="px-4 py-3 space-y-3">
                        <ul className="list-disc list-inside text-xs text-slate-300 space-y-1">{c.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        {c.evidence.map((ev) => (
                          <div key={ev.type} className="bg-black/30 rounded-md p-3 border border-slate-800">
                            <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">{ev.type}</span><span className="text-[11px] font-mono text-slate-500">{ev.detail}</span></div>
                            {ev.rows.length === 0 ? <div className="text-xs text-slate-600">no evidence</div> : (
                              <div className="max-h-44 overflow-y-auto">
                                <table className="w-full"><tbody>
                                  {ev.rows.map((r) => (
                                    <tr key={r} className="hover:bg-cyan-500/5">
                                      <Td className="pl-0"><TxnLink row={r} /></Td>
                                      <Td className="text-slate-500">{fmtTs(dataset.ts[r])}</Td>
                                      <Td className="text-slate-400 max-w-[180px] truncate">{dataset.sender[r] === a ? "→ " + dataset.accounts[dataset.receiver[r]] : "← " + dataset.accounts[dataset.sender[r]]}</Td>
                                      <Td className="text-right text-slate-100">{fmtINR(dataset.amount[r])}</Td>
                                    </tr>
                                  ))}
                                </tbody></table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          </>
        )}
      </div>

      <div className="space-y-4">
        <Panel title="Scoring weights" icon={<SlidersHorizontal size={13} />} actions={<Button variant="ghost" onClick={() => setWeights(DEFAULT_WEIGHTS)}><RotateCcw size={11} /></Button>}>
          <div className="space-y-3">
            {WLABELS.map((w) => (
              <div key={w.key}>
                <div className="flex justify-between text-xs mb-1"><span className="text-slate-300">{w.label}</span><span className="font-mono text-cyan-200">{weights[w.key]}</span></div>
                <input type="range" min={0} max={50} value={weights[w.key]} onChange={(e) => setWeights({ ...weights, [w.key]: Number(e.target.value) })} className="w-full" />
              </div>
            ))}
            <div className="text-[11px] font-mono text-slate-500 flex justify-between"><span>Σ weights</span><span className={totalW === 100 ? "text-emerald-300" : "text-amber-300"}>{totalW} {totalW !== 100 && "(normalized to 100)"}</span></div>
            <div className="text-[11px] text-slate-500">Deterministic: risk = Σ componentᵢ × weightᵢ × 100 / Σ weights. Changing weights re-scores all {fmtNum(analytics.nAcc)} accounts instantly.</div>
          </div>
        </Panel>

        <Panel title="Top mule candidates" icon={<Trophy size={13} />} className="[&>div:last-child]:p-0">
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-[#060b18]"><tr><Th>#</Th><Th>Account</Th><Th>Risk</Th><Th>Layer</Th></tr></thead>
              <tbody>
                {leaderboard.map((x, i) => (
                  <tr key={x} onClick={() => selectAccount(x)} className={"cursor-pointer hover:bg-cyan-500/5 " + (x === a ? "bg-cyan-500/10" : "")}>
                    <Td className="text-slate-500">{i + 1}</Td>
                    <Td><AccountLink acc={x} /></Td>
                    <Td><RiskBadge risk={analytics.risk[x]} /></Td>
                    <Td><LayerBadge layer={analytics.layer[x]} /></Td>
                  </tr>
                ))}
                {leaderboard.length === 0 && <tr><Td mono={false} className="text-slate-500">No accounts above medium risk.</Td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="text-[10px] font-mono text-slate-600 px-1 flex gap-2 flex-wrap"><Badge tone="cyan" className="shadow-none">0–39 LOW</Badge><Badge tone="amber" className="shadow-none">40–69 MED</Badge><Badge tone="red" className="shadow-none">70–100 HIGH</Badge></div>
      </div>
    </div>
  );
}

function Mini({ l, v }: { l: string; v: string }) {
  return <div className="glass rounded px-2 py-1.5"><div className="text-[9px] uppercase tracking-[0.18em] text-slate-500">{l}</div><div className="text-slate-100 truncate">{v}</div></div>;
}
