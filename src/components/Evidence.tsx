import { X, FileText, ArrowRight } from "lucide-react";
import { useStore, fmtINR, fmtTs } from "@/store";
import { originalRecord } from "@/engine/dataset";
import { FLAG_LABELS } from "@/engine/types";
import { Badge, Button, LayerBadge, RiskBadge } from "./ui";

export function TxnLink({ row, className }: { row: number; className?: string }) {
  const { dataset, openEvidence } = useStore();
  if (!dataset) return null;
  return (
    <button onClick={(e) => { e.stopPropagation(); openEvidence(row); }} className={"font-mono text-cyan-300 hover:text-cyan-100 hover:underline underline-offset-2 " + (className ?? "")} title="Open original record">
      {dataset.txnIds[row]}
    </button>
  );
}

export function AccountLink({ acc, className }: { acc: number; className?: string }) {
  const { dataset, selectAccount } = useStore();
  if (!dataset) return null;
  return (
    <button onClick={(e) => { e.stopPropagation(); selectAccount(acc, true); }} className={"font-mono text-slate-200 hover:text-cyan-200 hover:underline underline-offset-2 " + (className ?? "")} title="Open account risk profile">
      {dataset.accounts[acc]}
    </button>
  );
}

export function EvidenceDrawer() {
  const { dataset, analytics, evidenceRow, openEvidence, selectAccount, setTrailTarget, setView } = useStore();
  if (!dataset || !analytics || evidenceRow === null) return null;
  const row = evidenceRow;
  const rec = originalRecord(dataset, row);
  const s = dataset.sender[row], r = dataset.receiver[row];
  const flags = analytics.txnFlags[row];
  const flagList = Object.keys(FLAG_LABELS).map(Number).filter((f) => flags & f);
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-xl glass glass-strong border-l border-cyan-500/40 rounded-none flex flex-col shadow-2xl">
      <header className="px-5 py-4 border-b border-cyan-500/20 flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] tracking-[0.3em] text-cyan-300 flex items-center gap-2"><FileText size={12} /> EVIDENCE RECORD</div>
          <div className="font-mono text-lg text-slate-100 mt-1">{dataset.txnIds[row]}</div>
        </div>
        <button onClick={() => openEvidence(null)} className="text-slate-400 hover:text-red-300"><X size={18} /></button>
      </header>
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div className="flex flex-wrap gap-2">
          <Badge tone="slate">CSV ROW #{(row + 2).toLocaleString()}</Badge>
          <Badge tone="slate">INDEX {row}</Badge>
          {flagList.length === 0 && <Badge tone="cyan">NO FLAGS</Badge>}
          {flagList.map((f) => <Badge key={f} tone="red">{FLAG_LABELS[f]}</Badge>)}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
          <PartyCard label="SENDER" acc={s} risk={analytics.risk[s]} layer={analytics.layer[s]} onOpen={() => selectAccount(s, true)} />
          <div className="flex flex-col items-center text-cyan-300">
            <ArrowRight size={20} />
            <div className="font-mono text-xs text-slate-200 mt-1">{fmtINR(dataset.amount[row])}</div>
            <div className="font-mono text-[10px] text-slate-500">{dataset.modes[dataset.mode[row]]}</div>
          </div>
          <PartyCard label="RECEIVER" acc={r} risk={analytics.risk[r]} layer={analytics.layer[r]} onOpen={() => selectAccount(r, true)} />
        </div>
        <div className="font-mono text-xs text-slate-400">Timestamp <span className="text-slate-100 ml-2">{fmtTs(dataset.ts[row])}</span></div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-2">Original CSV record {rec.reconstructed && <span className="text-amber-300">(reconstructed from normalized columns — beyond raw retention cap)</span>}</div>
          <pre className="font-mono text-[11px] text-emerald-200 bg-black/50 border border-emerald-500/20 rounded-lg p-3 whitespace-pre-wrap break-all">{dataset.headers.join(",")}{"\n"}{rec.raw}</pre>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-2">Parsed fields</div>
          <table className="w-full text-xs font-mono">
            <tbody>
              {rec.fields.map((f, i) => (
                <tr key={i} className="border-b border-slate-800/60">
                  <td className="py-1.5 pr-3 text-slate-500 whitespace-nowrap">{f.header}</td>
                  <td className="py-1.5 text-slate-100 break-all">{f.value || <span className="text-red-400">∅ missing</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="ghost" onClick={() => { setTrailTarget(dataset.accounts[s]); setView("trail"); openEvidence(null); }}>Trace from sender</Button>
          <Button variant="ghost" onClick={() => { selectAccount(r); setView("graph"); openEvidence(null); }}>Isolate receiver subgraph</Button>
        </div>
      </div>
    </div>
  );
}

function PartyCard({ label, acc, risk, layer, onOpen }: { label: string; acc: number; risk: number; layer: number; onOpen: () => void }) {
  const { dataset } = useStore();
  return (
    <button onClick={onOpen} className="glass rounded-lg p-3 text-left hover:border-cyan-400/50 transition-colors">
      <div className="text-[9px] tracking-[0.25em] text-slate-500">{label}</div>
      <div className="font-mono text-xs text-slate-100 break-all mt-1">{dataset?.accounts[acc]}</div>
      <div className="mt-2 flex flex-wrap gap-1"><RiskBadge risk={risk} /><LayerBadge layer={layer} /></div>
    </button>
  );
}
