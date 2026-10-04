import { useMemo, useState } from "react";
import { FlaskConical, AlertOctagon, Upload } from "lucide-react";
import { useStore, fmtNum } from "@/store";
import { Panel, Stat, Button, Empty, Badge, Th, Td } from "@/components/ui";
import { evaluate, parseGroundTruth, truthFromList, tuneWeights, type GroundTruth, type TuneResult } from "@/engine/calibration";
import type { Weights } from "@/engine/types";

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const W_KEYS: (keyof Weights)[] = ["velocity", "l1", "l2", "l3", "centrality"];

export function CalibrationView() {
  const { dataset, analytics, weights, setWeights, demoHints, version } = useStore();
  const [truth, setTruth] = useState<GroundTruth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [thr, setThr] = useState<number | null>(null); // null = follow the best-F1 threshold
  const [tune, setTune] = useState<TuneResult | null>(null);
  const [busy, setBusy] = useState(false);

  // full evaluation of the CURRENT risk scores against the answer key (re-runs when weights change)
  const ev = useMemo(() => (dataset && analytics && truth ? evaluate(dataset, analytics.risk, truth) : null), [dataset, analytics, truth, version]);

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest the transaction CSV first, then load the ground-truth (answer key) file to measure accuracy.</Empty>;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try { setTruth(parseGroundTruth(await f.text(), f.name)); setErr(null); setTune(null); setThr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const useDemo = () => { if (demoHints) { setTruth(truthFromList(demoHints.mules, "synthetic planted mules")); setErr(null); setTune(null); setThr(null); } };
  const runTune = () => {
    if (!truth) return;
    setBusy(true);
    setTimeout(() => { try { setTune(tuneWeights(dataset, analytics, truth, weights)); } finally { setBusy(false); } }, 30);
  };

  const t = thr ?? ev?.best.threshold ?? 40;
  const cur = ev ? ev.sweep[t] : null;
  const prevalence = ev && ev.evaluated ? ev.positives / ev.evaluated : 0;

  return (
    <div className="space-y-4">
      <Panel title="Ground-truth answer key" icon={<FlaskConical size={13} />} strong>
        <div className="flex flex-wrap items-center gap-3">
          <label className="px-3 py-1.5 rounded-md border text-[11px] font-mono font-semibold tracking-wider uppercase cursor-pointer bg-cyan-500/15 border-cyan-400/50 text-cyan-200 hover:bg-cyan-500/25">
            <Upload size={12} className="inline mr-1" />Load ground-truth CSV
            <input type="file" accept=".csv,.txt" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {demoHints && <Button variant="ghost" onClick={useDemo}>Use synthetic planted mules</Button>}
          {truth && <Badge tone="emerald">{truth.source} · {truth.mode === "list" ? "mule list" : "labelled file"} · {fmtNum(truth.fileMules)} mules{truth.mode === "labelled" ? ` / ${fmtNum(truth.fileNormals)} normal` : ""}</Badge>}
        </div>
        <div className="mt-3 text-[11px] text-slate-500 font-mono leading-relaxed">
          Accepted formats: (1) two columns <b className="text-slate-300">account_id,is_mule</b> (1/0, true/false, mule/normal) or (2) a single column listing only the mule accounts - every other account is then treated as normal.
          For the contest dataset (1,500 injected mules vs 23,500 normal accounts) load the organisers' answer key here: every figure below is computed live from it - nothing is pre-filled.
        </div>
        {err && <div className="mt-3 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 flex items-center gap-2"><AlertOctagon size={14} /> {err}</div>}
      </Panel>

      {!ev || !cur ? <Empty title="Awaiting ground truth">Load the answer key to see precision, recall, F1, the confusion matrix and an automatic threshold / weight calibration.</Empty> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Stat label="Accounts scored" value={fmtNum(ev.evaluated)} sub={`${fmtNum(ev.positives)} mules · ${fmtNum(ev.negatives)} normal (${pct(prevalence)} mules)`} accent="cyan" />
            <Stat label={`Precision @ ${t}`} value={pct(cur.precision)} sub="flagged that really are mules" accent="emerald" />
            <Stat label={`Recall @ ${t}`} value={pct(cur.recall)} sub="mules actually caught" accent="amber" />
            <Stat label={`F1 @ ${t}`} value={pct(cur.f1)} sub={`best F1 ${pct(ev.best.f1)} @ ${ev.best.threshold}`} accent="emerald" />
            <Stat label="ROC-AUC" value={ev.auc.toFixed(3)} sub="1.000 = perfect separation" />
            <Stat label="False-positive rate" value={pct(cur.fpr)} sub={`${fmtNum(cur.fp)} normal accounts flagged`} accent={cur.fpr > 0.05 ? "red" : undefined} />
          </div>
          {(ev.missingFromDataset > 0 || ev.unlabelled > 0) && (
            <div className="text-[11px] font-mono text-amber-200 border border-amber-500/40 bg-amber-500/10 rounded px-3 py-2">
              {ev.missingFromDataset > 0 && <>{fmtNum(ev.missingFromDataset)} mule account(s) in the answer key never appear in the loaded transactions (they count as missed in your report, not here). </>}
              {ev.unlabelled > 0 && <>{fmtNum(ev.unlabelled)} dataset account(s) have no label in the key and were excluded.</>}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Panel title="Risk threshold & confusion matrix">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="text-[11px] font-mono text-slate-400">flag accounts with risk ≥</span>
                <input type="range" min={0} max={100} value={t} onChange={(e) => setThr(Number(e.target.value))} className="flex-1 min-w-[160px]" />
                <span className="font-mono text-cyan-300 w-8 text-right">{t}</span>
                <Button variant="ghost" onClick={() => setThr(null)}>Best F1 ({ev.best.threshold})</Button>
              </div>
              <div className="grid grid-cols-[auto_1fr_1fr] gap-1 text-center font-mono text-xs max-w-md">
                <div />
                <div className="text-[10px] uppercase tracking-wider text-slate-500 py-1">Predicted mule</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 py-1">Predicted normal</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 pr-2 self-center text-right">Actual mule</div>
                <div className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 py-3"><div className="text-lg text-emerald-300">{fmtNum(cur.tp)}</div><div className="text-[10px] text-slate-500">caught (TP)</div></div>
                <div className="rounded-lg border border-red-500/50 bg-red-500/10 py-3"><div className="text-lg text-red-300">{fmtNum(cur.fn)}</div><div className="text-[10px] text-slate-500">missed (FN)</div></div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 pr-2 self-center text-right">Actual normal</div>
                <div className="rounded-lg border border-amber-400/50 bg-amber-500/10 py-3"><div className="text-lg text-amber-300">{fmtNum(cur.fp)}</div><div className="text-[10px] text-slate-500">wrongly flagged (FP)</div></div>
                <div className="rounded-lg border border-slate-600/50 bg-slate-800/40 py-3"><div className="text-lg text-slate-200">{fmtNum(cur.tn)}</div><div className="text-[10px] text-slate-500">correctly cleared (TN)</div></div>
              </div>
              <div className="mt-3 text-[11px] text-slate-500">Accuracy {pct(cur.accuracy)} · balanced accuracy {pct(cur.balancedAccuracy)}. With only ~6% mules, plain accuracy is misleading - judge by precision, recall and F1.</div>
            </Panel>

            <Panel title="Threshold sweep (precision · recall · F1)">
              <SweepChart sweep={ev.sweep} at={t} />
            </Panel>
          </div>

          <Panel title="Auto-calibrate scoring weights (trained on 70% of accounts, reported on the unseen 30%)">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={runTune} disabled={busy || ev.positives === 0}>{busy ? "Searching weights…" : "Run calibration"}</Button>
              <div className="text-[11px] text-slate-500 font-mono max-w-3xl">Coordinate search over the five component weights, maximising F1. The held-out numbers are the honest estimate - the training numbers are only for reference.</div>
            </div>
            {tune && (
              <div className="mt-4 space-y-3">
                <div className="overflow-auto"><table className="w-full">
                  <thead><tr><Th>Weights</Th>{W_KEYS.map((k) => <Th key={k} className="text-right">{k}</Th>)}</tr></thead>
                  <tbody>
                    <tr><Td>current</Td>{W_KEYS.map((k) => <Td key={k} className="text-right">{weights[k]}</Td>)}</tr>
                    <tr><Td>calibrated</Td>{W_KEYS.map((k) => <Td key={k} className={"text-right " + (tune.weights[k] !== weights[k] ? "text-cyan-300" : "")}>{tune.weights[k]}</Td>)}</tr>
                  </tbody></table></div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="Held-out F1 · current" value={pct(tune.heldOutBefore.f1)} sub={`@ threshold ${tune.heldOutBefore.threshold}`} />
                  <Stat label="Held-out F1 · calibrated" value={pct(tune.heldOutAfter.f1)} sub={`@ threshold ${tune.heldOutAfter.threshold}`} accent={tune.heldOutAfter.f1 >= tune.heldOutBefore.f1 ? "emerald" : "red"} />
                  <Stat label="Held-out precision / recall" value={<span className="text-sm">{pct(tune.heldOutAfter.precision)} / {pct(tune.heldOutAfter.recall)}</span>} sub="calibrated weights" />
                  <Stat label="Train F1 before → after" value={<span className="text-sm">{pct(tune.trainF1Before)} → {pct(tune.trainF1After)}</span>} sub={`${tune.rounds} search rounds`} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => { setWeights(tune.weights); setThr(null); }} disabled={tune.heldOutAfter.f1 < tune.heldOutBefore.f1}>Apply calibrated weights</Button>
                  {tune.heldOutAfter.f1 < tune.heldOutBefore.f1 && <span className="text-[11px] font-mono text-amber-200">Calibration did not improve the unseen 30% - keeping the current weights is recommended.</span>}
                </div>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/** Tiny dependency-free SVG line chart of the three metrics against the risk threshold. */
function SweepChart({ sweep, at }: { sweep: { threshold: number; precision: number; recall: number; f1: number }[]; at: number }) {
  const W = 560, H = 230, L = 36, B = 26, T = 10, R = 10;
  const X = (t: number) => L + (t / 100) * (W - L - R);
  const Y = (v: number) => T + (1 - v) * (H - T - B);
  const line = (k: "precision" | "recall" | "f1") => sweep.map((m, i) => `${i ? "L" : "M"}${X(m.threshold).toFixed(1)},${Y(m[k]).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="rgba(148,163,184,0.15)" /><text x={L - 6} y={Y(v) + 3} textAnchor="end" fontSize={9} fill="#64748b" fontFamily="JetBrains Mono, monospace">{v * 100}%</text></g>)}
        {[0, 20, 40, 60, 80, 100].map((t) => <text key={t} x={X(t)} y={H - 8} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="JetBrains Mono, monospace">{t}</text>)}
        <path d={line("precision")} fill="none" stroke="#34d399" strokeWidth={2} />
        <path d={line("recall")} fill="none" stroke="#f59e0b" strokeWidth={2} />
        <path d={line("f1")} fill="none" stroke="#22d3ee" strokeWidth={2.5} />
        <line x1={X(at)} x2={X(at)} y1={T} y2={H - B} stroke="#f43f5e" strokeDasharray="4 3" />
      </svg>
      <div className="flex gap-4 text-[10px] font-mono text-slate-400 mt-1"><span className="text-emerald-300">━ precision</span><span className="text-amber-300">━ recall</span><span className="text-cyan-300">━ F1</span><span className="text-rose-400">┆ chosen threshold</span><span className="ml-auto">x-axis: risk threshold</span></div>
    </div>
  );
}
