import { useMemo, useState } from "react";
import { Search, Users, ListOrdered } from "lucide-react";
import { useStore, fmtINR, fmtNum, fmtTs, fmtMs } from "@/store";
import { Panel, Stat, Button, Input, Empty, Badge, RiskBadge, LayerBadge, Th, Td } from "@/components/ui";
import { TxnLink, AccountLink } from "@/components/Evidence";
import { accountHistory, bankOf } from "@/engine/forensics";
import { XF_CRYPTO, XF_FOREIGN_IP, XF_HEADLESS, XF_SCAM, XF_WALLET } from "@/engine/types";

export function ExplorerView() {
  const { dataset, analytics } = useStore();
  const [q, setQ] = useState("");
  const [a, setA] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const h = useMemo(() => (dataset && analytics && a !== null && a < dataset.accounts.length ? accountHistory(dataset, analytics, a) : null), [dataset, analytics, a]);

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest a CSV to search accounts.</Empty>;

  const run = () => {
    const v = q.trim();
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) {
      const sugg = dataset.accounts.filter((x) => x.toLowerCase().includes(v.toLowerCase())).slice(0, 4);
      setErr(`Account "${v}" not found.${sugg.length ? " Similar: " + sugg.join(", ") : ""}`); setA(null); return;
    }
    setErr(null); setA(idx);
  };

  return (
    <div className="space-y-4">
      <Panel title="Instant account search" icon={<Search size={13} />} strong>
        <div className="flex gap-2">
          <Input value={q} onChange={setQ} placeholder="Enter a 12-digit account number…" className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
          <Button onClick={run}>Search</Button>
        </div>
        {err && <div className="mt-2 text-xs text-red-300 font-mono border border-red-500/40 bg-red-500/10 rounded px-3 py-2">{err}</div>}
      </Panel>

      {a === null || !h ? <Empty title="Awaiting account">Full flow, counter-parties, banks, payment rails and cash-out signals are retrieved straight from the CSR index.</Empty> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Stat label="Account" value={<span className="text-sm break-all">{dataset.accounts[a]}</span>} sub={`${bankOf(dataset.accIfsc[a])}${dataset.accIfsc[a] ? " · " + dataset.accIfsc[a] : ""}`} accent="cyan" />
            <Stat label="Risk / layer" value={<div className="flex flex-col gap-1 items-start"><RiskBadge risk={analytics.risk[a]} /><LayerBadge layer={analytics.layer[a]} /></div>} />
            <Stat label="Inflow" value={fmtINR(analytics.inSum[a])} sub={`${fmtNum(analytics.inCount[a])} txns · ${fmtNum(analytics.uniqueIn[a])} senders`} accent="emerald" />
            <Stat label="Outflow" value={fmtINR(analytics.outSum[a])} sub={`${fmtNum(analytics.outCount[a])} txns · ${fmtNum(analytics.uniqueOut[a])} receivers`} accent="amber" />
            <Stat label="Pass-through ≤15m" value={`${(analytics.pass90[a] * 100).toFixed(0)}%`} sub={analytics.pass90[a] >= 0.9 ? "meets ≥90% rule" : "below 90% rule"} accent={analytics.pass90[a] >= 0.9 ? "red" : undefined} />
            <Stat label="Retrieval time" value={fmtMs(h.ms)} sub={`${fmtNum(h.rows.length)} txns`} accent="emerald" />
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] font-mono">
            <Badge tone={h.signals.foreign ? "red" : "slate"}>foreign IP × {h.signals.foreign}</Badge>
            <Badge tone={h.signals.headless ? "red" : "slate"}>headless client × {h.signals.headless}</Badge>
            <Badge tone={h.signals.crypto ? "red" : "slate"}>crypto/P2P narration × {h.signals.crypto}</Badge>
            <Badge tone={h.signals.wallet ? "amber" : "slate"}>wallet/gateway × {h.signals.wallet}</Badge>
            {h.modes.map((m) => <Badge key={m.mode} tone="cyan" className="shadow-none">{m.mode} × {fmtNum(m.count)}</Badge>)}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Panel title="Counter-parties" icon={<Users size={13} />} className="[&>div:last-child]:p-0">
              <div className="max-h-[480px] overflow-auto"><table className="w-full">
                <thead className="sticky top-0 bg-[#060b18]"><tr><Th>Account</Th><Th>Bank</Th><Th className="text-right">In</Th><Th className="text-right">Out</Th></tr></thead>
                <tbody>{h.cps.slice(0, 60).map((c) => (
                  <tr key={c.acc} className="hover:bg-cyan-500/5"><Td><AccountLink acc={c.acc} /></Td><Td className="text-slate-500">{bankOf(dataset.accIfsc[c.acc]).replace(/ \(.*/, "")}</Td><Td className="text-right text-emerald-300">{c.inAmt ? fmtINR(c.inAmt) : "—"}</Td><Td className="text-right text-amber-300">{c.outAmt ? fmtINR(c.outAmt) : "—"}</Td></tr>
                ))}</tbody></table></div>
            </Panel>
            <Panel title="Transaction timeline" icon={<ListOrdered size={13} />} className="xl:col-span-2 [&>div:last-child]:p-0">
              <div className="max-h-[480px] overflow-auto"><table className="w-full">
                <thead className="sticky top-0 bg-[#060b18]"><tr><Th>Time</Th><Th>Dir</Th><Th>Counter-party</Th><Th className="text-right">Amount</Th><Th>Mode</Th><Th>Txn ID</Th><Th>Signals</Th></tr></thead>
                <tbody>{h.rows.slice(0, 400).map((r) => {
                  const out = dataset.sender[r] === a; const x = dataset.xflag[r];
                  return (
                    <tr key={r} className="hover:bg-cyan-500/5">
                      <Td className="text-slate-400">{fmtTs(dataset.ts[r])}</Td>
                      <Td className={out ? "text-amber-300" : "text-emerald-300"}>{out ? "OUT →" : "← IN"}</Td>
                      <Td><AccountLink acc={out ? dataset.receiver[r] : dataset.sender[r]} /></Td>
                      <Td className="text-right text-slate-100">{fmtINR(dataset.amount[r])}</Td>
                      <Td className="text-slate-400">{dataset.modes[dataset.mode[r]]}</Td>
                      <Td><TxnLink row={r} /></Td>
                      <Td><div className="flex gap-1">{x & XF_FOREIGN_IP ? <Badge tone="red" className="shadow-none">IP</Badge> : null}{x & XF_HEADLESS ? <Badge tone="red" className="shadow-none">BOT</Badge> : null}{x & XF_CRYPTO ? <Badge tone="red" className="shadow-none">CRYPTO</Badge> : null}{x & XF_WALLET ? <Badge tone="amber" className="shadow-none">WALLET</Badge> : null}{x & XF_SCAM ? <Badge tone="violet" className="shadow-none">SCAM</Badge> : null}</div></Td>
                    </tr>
                  );
                })}</tbody></table></div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
