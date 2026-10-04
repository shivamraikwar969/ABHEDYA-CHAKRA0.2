import { StoreProvider, useStore } from "./store";
import { Sidebar, TopBar, IngestModal, ProgressOverlay } from "./components/Shell";
import { EvidenceDrawer } from "./components/Evidence";
import { VaultView } from "./views/VaultView";
import { GraphView } from "./views/GraphView";
import { RiskView } from "./views/RiskView";
import { TrailView } from "./views/TrailView";
import { SqlView } from "./views/SqlView";
import { ExplorerView } from "./views/ExplorerView";
import { FlowView } from "./views/FlowView";
import { CaseView } from "./views/CaseView";
import { CalibrationView } from "./views/CalibrationView";

const TITLES: Record<string, { step: string; title: string; desc: string }> = {
  vault: { step: "STEP 1–2", title: "Dataset Ingestion & Profiling Vault", desc: "Record counts, unique accounts, missing-value matrix, duplicate checks and benchmark timings." },
  graph: { step: "STEP 3", title: "Interactive Transaction Graph", desc: "Directed sender → receiver network with full-tree, flagged and account-isolated views." },
  risk: { step: "STEP 4–5", title: "Behavioral Mule Analysis · Risk Index 0–100", desc: "Deterministic weighted scoring with component breakdown and evidence traceability." },
  trail: { step: "STEP 6", title: "4-Hop Victim Money Trail", desc: "Bounded BFS traversal (Hop 1 → Hop 4) with cycle detection and multi-branch handling." },
  explorer: { step: "MODULE A", title: "Account Explorer · Instant Search", desc: "Complete historical flow, counter-parties, banks and cash-out signals for any account in milliseconds." },
  flow: { step: "MODULE C", title: "Flow Playback & Ring Isolation", desc: "Hierarchical flow tree with minute-by-minute temporal playback and one-click syndicate isolation + export." },
  case: { step: "MODULE D", title: "AI Case Officer · Case Diary & Sec. 91 / BNSS Notices", desc: "Graph-grounded narrative with a programmatic anti-hallucination guardrail." },
  calib: { step: "VALIDATE", title: "Ground-Truth Calibration", desc: "Load the answer key (known mules vs normal accounts) to measure precision, recall, F1 and auto-calibrate the risk weights." },
  sql: { step: "SQL", title: "DuckDB Analytical Console", desc: "High-speed local SQL over the ingested dataset." },
};

function Main() {
  const { view } = useStore();
  const t = TITLES[view];
  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 relative">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] tracking-[0.35em] text-cyan-400">{t.step}</div>
              <h1 className="text-xl font-semibold text-slate-100 mt-0.5">{t.title}</h1>
              <p className="text-xs text-slate-500 mt-0.5">{t.desc}</p>
            </div>
          </div>
          <div className={view === "graph" ? "h-[calc(100%-5rem)] min-h-[640px]" : ""}>
            {view === "vault" && <VaultView />}
            {view === "graph" && <GraphView />}
            {view === "risk" && <RiskView />}
            {view === "trail" && <TrailView />}
            {view === "sql" && <SqlView />}
            {view === "explorer" && <ExplorerView />}
            {view === "flow" && <FlowView />}
            {view === "case" && <CaseView />}
            {view === "calib" && <CalibrationView />}
          </div>
        </main>
      </div>
      <IngestModal />
      <ProgressOverlay />
      <EvidenceDrawer />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Main />
    </StoreProvider>
  );
}
