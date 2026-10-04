import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type Analytics, type ColumnMapping, type Dataset, type Weights, DEFAULT_WEIGHTS } from "./engine/types";
import { generateSyntheticCSV, ingestCSV, previewCSV, type IngestProgress, type PreviewResult } from "./engine/dataset";
import { applyWeights, computeAnalytics } from "./engine/analytics";
import { duck, type EngineStatus } from "./engine/duckdb";

export type View = "vault" | "graph" | "risk" | "trail" | "sql" | "explorer" | "flow" | "case" | "calib";
export type Phase = "empty" | "preview" | "ingesting" | "analyzing" | "ready";

interface PendingSource { source: File | string; name: string; preview: PreviewResult; }

interface StoreValue {
  phase: Phase;
  dataset: Dataset | null;
  analytics: Analytics | null;
  version: number;
  weights: Weights;
  setWeights: (w: Weights) => void;
  progress: IngestProgress | null;
  error: string | null;
  clearError: () => void;
  pending: PendingSource | null;
  openFile: (f: File) => Promise<void>;
  loadDemo: (rows: number) => Promise<void>;
  confirmIngest: (mapping: ColumnMapping) => Promise<void>;
  cancelPending: () => void;
  view: View;
  setView: (v: View) => void;
  selectedAccount: number | null;
  selectAccount: (a: number | null, jump?: boolean) => void;
  evidenceRow: number | null;
  openEvidence: (row: number | null) => void;
  duckStatus: EngineStatus;
  duckLoadMs: number;
  duckTableLoaded: boolean;
  demoHints: { victims: string[]; mules: string[] } | null;
  trailTarget: string | null;
  setTrailTarget: (s: string | null) => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("empty");
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [version, setVersion] = useState(0);
  const [weights, setWeightsState] = useState<Weights>(DEFAULT_WEIGHTS);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSource | null>(null);
  const [view, setView] = useState<View>("vault");
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [evidenceRow, setEvidenceRow] = useState<number | null>(null);
  const [duckStatus, setDuckStatus] = useState<EngineStatus>(duck.status);
  const [duckLoadMs, setDuckLoadMs] = useState(0);
  const [duckTableLoaded, setDuckTableLoaded] = useState(false);
  const [demoHints, setDemoHints] = useState<{ victims: string[]; mules: string[] } | null>(null);
  const [trailTarget, setTrailTarget] = useState<string | null>(null);
  const weightsRef = useRef(weights);

  useEffect(() => {
    const unsub = duck.subscribe(() => { setDuckStatus(duck.status); setDuckLoadMs(duck.loadMs); setDuckTableLoaded(duck.tableLoaded); });
    duck.init();
    return unsub;
  }, []);

  const openFile = useCallback(async (f: File) => {
    try {
      setError(null);
      const preview = await previewCSV(f);
      setPending({ source: f, name: f.name, preview });
      setDemoHints(null);
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDemo = useCallback(async (rows: number) => {
    setError(null);
    setProgress({ rows: 0, bytes: 0, totalBytes: 1, phase: `Synthesizing ${rows.toLocaleString()} transactions with planted mule rings` });
    setPhase("ingesting");
    await new Promise((r) => setTimeout(r, 30));
    try {
      const { csv, victims, mules } = generateSyntheticCSV(rows);
      const preview = await previewCSV(csv);
      setDemoHints({ victims, mules });
      setPending({ source: csv, name: `setu_synthetic_${rows}.csv`, preview });
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(dataset ? "ready" : "empty");
    }
  }, [dataset]);

  const confirmIngest = useCallback(async (mapping: ColumnMapping) => {
    if (!pending) return;
    if (mapping.sender < 0 || mapping.receiver < 0) { setError("Sender and Receiver columns must be mapped."); return; }
    setError(null);
    setPhase("ingesting");
    setProgress({ rows: 0, bytes: 0, totalBytes: 1, phase: "Starting ingestion" });
    try {
      const ds = await ingestCSV(pending.source, pending.name, pending.preview.headers, mapping, setProgress);
      setPhase("analyzing");
      setProgress({ rows: ds.rowCount, bytes: 1, totalBytes: 1, phase: "Building adjacency & behavioral risk model" });
      await new Promise((r) => setTimeout(r, 40));
      const an = computeAnalytics(ds);
      applyWeights(ds, an, weightsRef.current);
      setDataset(ds);
      setAnalytics(an);
      setSelectedAccount(null);
      setVersion((v) => v + 1);
      setPending(null);
      setPhase("ready");
      setView("vault");
      // DuckDB load in background
      if (duck.ready) {
        setDuckTableLoaded(false);
        duck.loadDataset(pending.source, pending.preview.headers, mapping).catch((e) => console.warn("DuckDB load failed", e));
      }
    } catch (e) {
      setError("Ingestion failed: " + (e instanceof Error ? e.message : String(e)));
      setPhase(dataset ? "ready" : "empty");
    }
  }, [pending, dataset]);

  // if DuckDB becomes ready after dataset already loaded, load it then
  useEffect(() => {
    if (duckStatus === "ready" && dataset && !duck.tableLoaded) {
      duck.loadDataset(dataset.source, dataset.headers, dataset.mapping).catch(() => {});
    }
  }, [duckStatus, dataset]);

  const setWeights = useCallback((w: Weights) => {
    weightsRef.current = w;
    setWeightsState(w);
    if (dataset && analytics) {
      applyWeights(dataset, analytics, w);
      setVersion((v) => v + 1);
    }
  }, [dataset, analytics]);

  const selectAccount = useCallback((a: number | null, jump?: boolean) => {
    setSelectedAccount(a);
    if (jump && a !== null) setView("risk");
  }, []);

  const value = useMemo<StoreValue>(() => ({
    phase, dataset, analytics, version, weights, setWeights, progress, error, clearError: () => setError(null), pending,
    openFile, loadDemo, confirmIngest, cancelPending: () => { setPending(null); setPhase(dataset ? "ready" : "empty"); },
    view, setView, selectedAccount, selectAccount, evidenceRow, openEvidence: setEvidenceRow,
    duckStatus, duckLoadMs, duckTableLoaded, demoHints, trailTarget, setTrailTarget,
  }), [phase, dataset, analytics, version, weights, setWeights, progress, error, pending, openFile, loadDemo, confirmIngest, view, selectedAccount, selectAccount, evidenceRow, duckStatus, duckLoadMs, duckTableLoaded, demoHints, trailTarget]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside provider");
  return v;
}

export const fmtINR = (n: number) => (isNaN(n) ? "—" : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
export const fmtNum = (n: number) => n.toLocaleString("en-IN");
export const fmtTs = (t: number) => {
  if (isNaN(t)) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const fmtMs = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`);
export const abbr = (n: number) => (n >= 1e7 ? (n / 1e7).toFixed(1) + "Cr" : n >= 1e5 ? (n / 1e5).toFixed(1) + "L" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0));
