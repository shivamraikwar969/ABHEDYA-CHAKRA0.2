export interface ColumnMapping {
  txnId: number;
  sender: number;
  receiver: number;
  amount: number;
  timestamp: number;
  mode: number;
  ifscS: number;
  ifscR: number;
  narration: number;
  ip: number;
  device: number;
}

export type MappingKey = keyof ColumnMapping;

export interface ColumnProfile {
  name: string;
  nulls: number;
  nullPct: number;
  mapped: MappingKey | null;
}

export interface Profile {
  columns: ColumnProfile[];
  duplicateTxnIds: number;
  duplicateFullRows: number;
  invalidAmounts: number;
  invalidTimestamps: number;
  selfTransfers: number;
  amountMin: number;
  amountMax: number;
  amountSum: number;
  amountMean: number;
  tsMin: number;
  tsMax: number;
  modeDistribution: { mode: string; count: number }[];
  missingMatrix: Uint8Array; // sampleRows x columns, 1 = missing
  missingMatrixRows: number;
}

export interface Dataset {
  name: string;
  sizeBytes: number;
  headers: string[];
  rowCount: number;
  accounts: string[];
  accountIndex: Map<string, number>;
  txnIds: string[];
  sender: Int32Array;
  receiver: Int32Array;
  amount: Float64Array;
  ts: Float64Array; // epoch ms, NaN if unparsable
  mode: Uint16Array;
  modes: string[];
  xflag: Uint8Array; // per-txn cash-out signal bits (XF_*)
  accIfsc: string[]; // per-account IFSC (normalized)
  rawLines: string[];
  rawRetained: number;
  mapping: ColumnMapping;
  profile: Profile;
  timings: Record<string, number>;
  source: File | string; // original File or CSV text (for DuckDB)
}

export interface Weights {
  velocity: number;
  l1: number;
  l2: number;
  l3: number;
  centrality: number;
}

export const DEFAULT_WEIGHTS: Weights = { velocity: 30, l1: 20, l2: 20, l3: 20, centrality: 10 };

export const LAYER_NONE = 0;
export const LAYER_L1 = 1;
export const LAYER_L2 = 2;
export const LAYER_L3 = 3;
export const LAYER_LABELS = ["Endpoint / Unclassified", "L1 Collector", "L2 Distributor", "L3 Indicator"];

export interface Analytics {
  nAcc: number;
  // CSR adjacency, time-ordered within each account
  outStart: Int32Array;
  outIdx: Int32Array;
  inStart: Int32Array;
  inIdx: Int32Array;
  inCount: Int32Array;
  outCount: Int32Array;
  inSum: Float64Array;
  outSum: Float64Array;
  uniqueIn: Int32Array;
  uniqueOut: Int32Array;
  maxIn1h: Int32Array;
  txnPerDay: Float32Array;
  passThroughFrac: Float32Array;
  medianLatencyMin: Float32Array;
  roundFrac: Float32Array;
  structFrac: Float32Array;
  nightFrac: Float32Array;
  burstFlag: Uint8Array;
  cashoutFrac: Float32Array;
  pass90: Float32Array; // share of inbound value re-dispersed within 15 min
  xFrac: Float32Array; // share of txns carrying cash-out signals (foreign IP / headless / crypto / wallet)
  // components 0..1
  cVelocity: Float32Array;
  cL1: Float32Array;
  cL2: Float32Array;
  cL3: Float32Array;
  cCentrality: Float32Array;
  risk: Uint8Array;
  layer: Uint8Array;
  // per-txn flags bitmask
  txnFlags: Uint8Array;
  flaggedRows: Int32Array;
  maxDegree: number;
  timings: Record<string, number>;
}

export const XF_FOREIGN_IP = 1;
export const XF_HEADLESS = 2;
export const XF_CRYPTO = 4;
export const XF_WALLET = 8;
export const XF_SCAM = 16;
export const XF_ANY = 15;

export const FLAG_HIGH_RISK_RECEIVER = 1;
export const FLAG_HIGH_RISK_SENDER = 2;
export const FLAG_STRUCTURING = 4;
export const FLAG_RAPID_PASSTHROUGH = 8;
export const FLAG_ROUND_LARGE = 16;

export const FLAG_LABELS: Record<number, string> = {
  1: "HIGH-RISK RECEIVER",
  2: "HIGH-RISK SENDER",
  4: "STRUCTURING",
  8: "RAPID PASS-THROUGH",
  16: "LARGE ROUND AMOUNT",
};

export interface TrailEdge {
  hop: number;
  row: number;
  sender: number;
  receiver: number;
  amount: number;
  ts: number;
  txnId: string;
  layer: number;
  risk: number;
  cycle: boolean;
}

export interface TrailResult {
  victim: number;
  edges: TrailEdge[];
  hopCounts: number[];
  accountsVisited: number;
  cyclesDetected: number;
  truncated: boolean;
  totalAmount: number;
  ms: number;
}

export interface EvidenceItem {
  type: string;
  detail: string;
  rows: number[];
}

export interface ComponentBreakdown {
  key: keyof Weights;
  label: string;
  value: number; // 0..1
  weight: number;
  points: number;
  reasoning: string[];
  evidence: EvidenceItem[];
}

// ---------------- Fraud-pattern detection (graph.ts) + mule scoring (analytics.ts) ----------------
export type PatternKind = "LAYERING_RING" | "FAN_IN" | "FAN_OUT" | "QUICK_IN_QUICK_OUT";

export const PATTERN_LABELS: Record<PatternKind, string> = {
  LAYERING_RING: "Layering ring",
  FAN_IN: "Fan-in smurfing",
  FAN_OUT: "Fan-out smurfing",
  QUICK_IN_QUICK_OUT: "Quick-in / quick-out velocity trap",
};

/** Bit per pattern in PatternReport.mask (per-account). */
export const PAT_RING = 1;
export const PAT_FAN_IN = 2;
export const PAT_FAN_OUT = 4;
export const PAT_QIQO = 8;

export interface PatternHit {
  kind: PatternKind;
  accounts: number[]; // hub first for fan/QIQO; cycle order for rings
  rows: number[]; // evidence rows (capped)
  score: number; // 0..1 deterministic severity
  totalAmount: number;
  startTs: number;
  endTs: number;
  detail: string;
}

export interface PatternReport {
  hits: PatternHit[];
  mask: Uint8Array; // per-account PAT_* bits
  counts: Record<PatternKind, number>;
  truncated: boolean; // a search budget was exhausted (result is a lower bound)
  ms: number;
}

export interface MuleComponent { key: string; label: string; value: number; weight: number; points: number; note: string; }
export interface MuleScores {
  score: Uint8Array; // 0..100 per account
  explain: Map<number, MuleComponent[]>; // only for candidate accounts
  ms: number;
}
