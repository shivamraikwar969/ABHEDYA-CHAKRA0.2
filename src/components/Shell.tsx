import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Database, GitBranch, Radar, Route, ShieldAlert, Terminal, Upload, X, Cpu, Wifi, WifiOff, FlaskConical, Search, Play, FileText } from "lucide-react";
import { useStore, type View, fmtNum } from "@/store";
import { Badge, Button, Select } from "./ui";
import { cn } from "@/utils/cn";
import type { ColumnMapping, MappingKey } from "@/engine/types";

const NAV: { id: View; label: string; step: string; icon: ReactNode }[] = [
  { id: "vault", label: "Profiling Vault", step: "STEP 1–2", icon: <Database size={16} /> },
  { id: "graph", label: "Transaction Graph", step: "STEP 3", icon: <GitBranch size={16} /> },
  { id: "risk", label: "Mule Risk Index", step: "STEP 4–5", icon: <Radar size={16} /> },
  { id: "trail", label: "4-Hop Money Trail", step: "STEP 6", icon: <Route size={16} /> },
  { id: "sql", label: "DuckDB Console", step: "SQL", icon: <Terminal size={16} /> },
  { id: "explorer", label: "Account Explorer", step: "MODULE A", icon: <Search size={16} /> },
  { id: "flow", label: "Flow Playback & Isolation", step: "MODULE C", icon: <Play size={16} /> },
  { id: "case", label: "AI Case Officer", step: "MODULE D", icon: <FileText size={16} /> },
  { id: "calib", label: "Ground-Truth Calibration", step: "VALIDATE", icon: <FlaskConical size={16} /> },
];

export function Sidebar() {
  const { view, setView, dataset, analytics, duckStatus } = useStore();
  const [demoRows, setDemoRows] = useState("100000");
  const { loadDemo, phase } = useStore();
  const busy = phase === "ingesting" || phase === "analyzing";
  const highRisk = analytics ? countHigh(analytics.risk) : 0;
  return (
    <aside className="w-64 shrink-0 h-full flex flex-col glass border-r border-cyan-500/15 rounded-none">
      <div className="px-5 py-4 border-b border-cyan-500/15">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/15 border border-cyan-400/50 flex items-center justify-center glow-cyan"><ShieldAlert className="text-cyan-300" size={18} /></div>
          <div>
            <div className="font-mono text-[13px] font-bold text-cyan-200 tracking-[0.2em] text-glow">ABHEDYA-CHAKRA</div>
            <div className="text-[10px] text-slate-500 tracking-[0.3em] font-mono">CODENAME · SETU</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
        {NAV.map((n) => (
          <button key={n.id} onClick={() => setView(n.id)} className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all", view === n.id ? "bg-cyan-500/15 border-cyan-400/50 text-cyan-100 glow-cyan" : "border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200")}>
            <span className={cn(view === n.id ? "text-cyan-300" : "text-slate-500")}>{n.icon}</span>
            <span className="flex-1">
              <span className="block text-[13px] font-medium">{n.label}</span>
              <span className="block text-[9px] font-mono tracking-[0.25em] text-slate-500">{n.step}</span>
            </span>
            {n.id === "risk" && highRisk > 0 && <Badge tone="red" className="shadow-none">{highRisk}</Badge>}
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-cyan-500/15 space-y-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 flex items-center gap-1"><FlaskConical size={11} /> Synthetic range</div>
        <div className="flex gap-2">
          <Select value={demoRows} onChange={setDemoRows} className="flex-1 text-xs py-1" options={[{ value: "50000", label: "50k rows" }, { value: "100000", label: "100k rows" }, { value: "500000", label: "500k rows" }, { value: "2000000", label: "2M rows" }]} />
          <Button disabled={busy} onClick={() => loadDemo(Number(demoRows))}>Load</Button>
        </div>
      </div>
      <div className="px-4 py-3 border-t border-cyan-500/15 text-[10px] font-mono text-slate-500 space-y-1.5">
        <div className="flex items-center justify-between"><span className="flex items-center gap-1"><Cpu size={11} /> SETU-Columnar</span><span className="text-emerald-400">ONLINE</span></div>
        <div className="flex items-center justify-between"><span className="flex items-center gap-1">{duckStatus === "ready" ? <Wifi size={11} /> : <WifiOff size={11} />} DuckDB-WASM</span>
          <span className={cn(duckStatus === "ready" ? "text-emerald-400" : duckStatus === "loading" ? "text-amber-300" : "text-slate-500")}>{duckStatus.toUpperCase()}</span></div>
        {dataset && <div className="flex items-center justify-between"><span>Records</span><span className="text-cyan-300">{fmtNum(dataset.rowCount)}</span></div>}
      </div>
    </aside>
  );
}

function countHigh(risk: Uint8Array) { let c = 0; for (let i = 0; i < risk.length; i++) if (risk[i] >= 70) c++; return c; }

export function TopBar() {
  const { openFile, dataset, phase, error, clearError, duckStatus, duckTableLoaded } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const busy = phase === "ingesting" || phase === "analyzing";
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 9000);
    return () => clearTimeout(t);
  }, [error, clearError]);
  return (
    <header className="h-14 shrink-0 glass rounded-none border-b border-cyan-500/15 flex items-center gap-4 px-5">
      <div className="flex items-center gap-2 text-[11px] font-mono tracking-[0.2em] text-slate-400">
        <Activity size={14} className="text-cyan-400" /> CYBER-FORENSIC COMMAND CENTER
      </div>
      <div className="flex-1" />
      {dataset && (
        <div className="hidden md:flex items-center gap-2 text-[11px] font-mono text-slate-400">
          <Badge tone="emerald">DATASET</Badge>
          <span className="text-slate-200 truncate max-w-[220px]">{dataset.name}</span>
          <span className="text-slate-500">· {fmtNum(dataset.rowCount)} rows · {fmtNum(dataset.accounts.length)} accounts</span>
        </div>
      )}
      <Badge tone={duckStatus === "ready" ? (duckTableLoaded ? "emerald" : "cyan") : duckStatus === "loading" ? "amber" : "slate"}>
        {duckStatus === "ready" ? (duckTableLoaded ? "DuckDB · TABLE READY" : "DuckDB · READY") : duckStatus === "loading" ? "DuckDB · LOADING" : "DuckDB · OFFLINE FALLBACK"}
      </Badge>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) openFile(f); }}
        className={cn("flex items-center gap-2 border border-dashed rounded-lg px-3 py-1.5 transition-colors", drag ? "border-cyan-400 bg-cyan-500/10" : "border-cyan-500/30")}
      >
        <Upload size={14} className="text-cyan-300" />
        <span className="text-[11px] font-mono text-slate-400 hidden lg:inline">Drop CSV or</span>
        <Button disabled={busy} onClick={() => fileRef.current?.click()}>Upload CSV</Button>
        <input ref={fileRef} type="file" accept=".csv,text/csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ""; }} />
      </div>
      {error && (
        <div className="absolute top-16 right-5 z-50 glass border-red-500/60 rounded-lg px-4 py-3 text-sm text-red-200 flex items-start gap-3 max-w-md glow-red">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" /><span className="flex-1">{error}</span>
          <button onClick={clearError}><X size={14} /></button>
        </div>
      )}
    </header>
  );
}

const MAP_FIELDS: { key: MappingKey; label: string; required?: boolean }[] = [
  { key: "txnId", label: "Transaction ID" }, { key: "sender", label: "Sender account", required: true }, { key: "receiver", label: "Receiver account", required: true },
  { key: "amount", label: "Amount" }, { key: "timestamp", label: "Timestamp" }, { key: "mode", label: "Payment mode" },
  { key: "ifscS", label: "Sender IFSC" }, { key: "ifscR", label: "Receiver IFSC" }, { key: "narration", label: "Narration" }, { key: "ip", label: "IP address" }, { key: "device", label: "Device type" },
];

export function IngestModal() {
  const { pending, confirmIngest, cancelPending } = useStore();
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  useEffect(() => { setMapping(pending ? { ...pending.preview.mapping } : null); }, [pending]);
  if (!pending || !mapping) return null;
  const { headers, rows } = pending.preview;
  const opts = [{ value: "-1", label: "— not mapped —" }, ...headers.map((h, i) => ({ value: String(i), label: h }))];
  const valid = mapping.sender >= 0 && mapping.receiver >= 0 && mapping.sender !== mapping.receiver;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="glass glass-strong rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <header className="px-6 py-4 border-b border-cyan-500/20 flex items-center justify-between">
          <div>
            <div className="font-mono text-xs tracking-[0.25em] text-cyan-300">STEP 1 · SCHEMA NORMALIZATION</div>
            <div className="text-slate-200 font-medium mt-1 truncate max-w-xl">{pending.name} <span className="text-slate-500 text-sm">· {headers.length} columns detected</span></div>
          </div>
          <button onClick={cancelPending} className="text-slate-400 hover:text-red-300"><X size={18} /></button>
        </header>
        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          {MAP_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{f.label} {f.required && <span className="text-red-400">*</span>}</span>
              <Select value={String(mapping[f.key])} onChange={(v) => setMapping({ ...mapping, [f.key]: Number(v) })} options={opts} />
            </label>
          ))}
        </div>
        <div className="px-6 pb-4 overflow-x-auto">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-2">Preview · first {rows.length} records</div>
          <table className="w-full text-xs font-mono">
            <thead><tr>{headers.map((h, i) => <th key={i} className={cn("text-left px-2 py-1 border-b border-cyan-500/20 whitespace-nowrap", Object.values(mapping).includes(i) ? "text-cyan-300" : "text-slate-500")}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{headers.map((_, ci) => <td key={ci} className="px-2 py-1 text-slate-300 whitespace-nowrap border-b border-slate-800/60">{r[ci] ?? <span className="text-red-400">∅</span>}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <footer className="px-6 py-4 border-t border-cyan-500/20 flex items-center justify-between">
          <div className="text-[11px] text-slate-500">Rows are streamed into typed columnar arrays (Int32/Float64) with a shared account dictionary. Original CSV lines are retained for evidence traceability (first 1,000,000 rows; others reconstructed).</div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={cancelPending}>Cancel</Button>
            <Button disabled={!valid} onClick={() => confirmIngest(mapping)}>Ingest &amp; Analyze</Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function ProgressOverlay() {
  const { phase, progress } = useStore();
  if (phase !== "ingesting" && phase !== "analyzing") return null;
  const pct = progress && progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center">
      <div className="glass glass-strong rounded-2xl w-full max-w-lg p-8 text-center scanline relative">
        <div className="font-mono text-xs tracking-[0.3em] text-cyan-300 mb-6">{phase === "ingesting" ? "INGESTING DATASET" : "BEHAVIORAL ANALYSIS"}</div>
        <div className="font-mono text-4xl font-bold text-cyan-100 text-glow">{fmtNum(progress?.rows ?? 0)}</div>
        <div className="text-[11px] text-slate-500 font-mono mt-1">records processed</div>
        <div className="mt-6 h-2 bg-slate-800 rounded-full overflow-hidden">
          {phase === "ingesting" && pct > 0 ? <div className="h-full bg-cyan-400 transition-all" style={{ width: `${pct}%`, boxShadow: "0 0 10px #06b6d4" }} /> : <div className="h-full w-full shimmer" />}
        </div>
        <div className="mt-3 text-xs text-slate-400 font-mono">{progress?.phase}</div>
      </div>
    </div>
  );
}
