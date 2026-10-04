import Papa from "papaparse";
import type { Analytics, Dataset, Weights } from "./types";

/**
 * GROUND-TRUTH CALIBRATION
 * ------------------------
 * The organisers evaluate on a dataset where the mules are KNOWN (e.g. 1,500 injected mules
 * among 23,500 normal accounts). This module lets the team load that answer key and measure,
 * with real numbers, how well the Mule Risk Index separates the two groups:
 *   - confusion matrix / precision / recall / F1 at any risk threshold
 *   - a full 0..100 threshold sweep + ROC-AUC + the best-F1 threshold
 *   - an optional weight tuner that is trained on 70% of accounts and reported on a
 *     held-out 30%, so the reported number is not over-fitted.
 * Nothing here is hard-coded to a dataset: it works with whatever truth file is loaded.
 */

export interface GroundTruth {
  /** account -> true if mule. In "list" mode every account NOT listed is treated as normal. */
  labels: Map<string, boolean>;
  mode: "list" | "labelled";
  fileMules: number;
  fileNormals: number;
  source: string;
}

const TRUTHY = /^(1|1\.0|true|t|yes|y|mule|fraud|illicit|suspicious|positive)$/i;

/** Parse a truth CSV. Accepts (a) a 2-column file account,label  or (b) a 1-column list of mule accounts. */
export function parseGroundTruth(text: string, source: string): GroundTruth {
  const res = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const rows = res.data.filter((r) => r.length > 0 && r.some((c) => String(c).trim() !== ""));
  if (!rows.length) throw new Error("Ground-truth file is empty.");
  const head = rows[0].map((h) => String(h).trim());
  const looksHeader = head.some((h) => /[A-Za-z_]{3,}/.test(h) && /acc|id|mule|label|fraud|class|target|truth|flag/i.test(h));
  const body = looksHeader ? rows.slice(1) : rows;
  let idCol = looksHeader ? head.findIndex((h) => /acc|^id$|acct/i.test(h)) : 0;
  if (idCol < 0) idCol = 0;
  let labCol = looksHeader ? head.findIndex((h, i) => i !== idCol && /mule|label|fraud|class|target|truth|flag|is_/i.test(h)) : (head.length > 1 ? 1 : -1);
  if (labCol >= head.length) labCol = -1;
  const labels = new Map<string, boolean>();
  let m = 0, n = 0;
  for (const r of body) {
    const id = String(r[idCol] ?? "").trim();
    if (!id) continue;
    let isMule = true; // list mode: presence = mule
    if (labCol >= 0) {
      const v = String(r[labCol] ?? "").trim();
      isMule = TRUTHY.test(v) || (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0);
    }
    labels.set(id, isMule);
    if (isMule) m++; else n++;
  }
  if (!labels.size) throw new Error("No account IDs found in the ground-truth file.");
  return { labels, mode: labCol >= 0 ? "labelled" : "list", fileMules: m, fileNormals: n, source };
}

/** Build a truth set from a plain list of known mule account IDs (used for the synthetic demo). */
export function truthFromList(ids: string[], source: string): GroundTruth {
  const labels = new Map<string, boolean>();
  ids.forEach((i) => labels.set(i, true));
  return { labels, mode: "list", fileMules: ids.length, fileNormals: 0, source };
}

export interface Confusion { tp: number; fp: number; fn: number; tn: number; }
export interface Metrics extends Confusion {
  threshold: number;
  precision: number; recall: number; f1: number; fpr: number; accuracy: number; balancedAccuracy: number;
}

export interface Evaluation {
  evaluated: number; // accounts that were scored against the truth
  positives: number; // known mules among them
  negatives: number;
  missingFromDataset: number; // truth accounts that do not appear in the loaded transactions
  unlabelled: number; // dataset accounts with no label (labelled mode only) - excluded
  hist: { pos: Int32Array; neg: Int32Array };
  sweep: Metrics[]; // threshold 0..100
  best: Metrics; // best-F1 threshold
  auc: number;
}

const safe = (a: number, b: number) => (b > 0 ? a / b : 0);

export function metricsFrom(c: Confusion, threshold: number): Metrics {
  const precision = safe(c.tp, c.tp + c.fp);
  const recall = safe(c.tp, c.tp + c.fn);
  const fpr = safe(c.fp, c.fp + c.tn);
  return {
    ...c, threshold, precision, recall, fpr,
    f1: safe(2 * precision * recall, precision + recall),
    accuracy: safe(c.tp + c.tn, c.tp + c.fp + c.fn + c.tn),
    balancedAccuracy: (recall + (1 - fpr)) / 2,
  };
}

/** Score every labelled account of the loaded dataset against the truth file. */
export function evaluate(ds: Dataset, risk: ArrayLike<number>, truth: GroundTruth, subset?: (acc: string) => boolean): Evaluation {
  const pos = new Int32Array(101), neg = new Int32Array(101);
  let evaluated = 0, positives = 0, unlabelled = 0;
  for (let a = 0; a < ds.accounts.length; a++) {
    const id = ds.accounts[a];
    if (subset && !subset(id)) continue;
    let lab = truth.labels.get(id);
    if (lab === undefined) { if (truth.mode === "list") lab = false; else { unlabelled++; continue; } }
    const r = Math.max(0, Math.min(100, Math.round(risk[a])));
    if (lab) { pos[r]++; positives++; } else neg[r]++;
    evaluated++;
  }
  let missing = 0;
  for (const [id, lab] of truth.labels) if (lab && !ds.accountIndex.has(id) && (!subset || subset(id))) missing++;
  return finish(pos, neg, evaluated, positives, missing, unlabelled);
}

function finish(pos: Int32Array, neg: Int32Array, evaluated: number, positives: number, missing: number, unlabelled: number): Evaluation {
  const negatives = evaluated - positives;
  const sweep: Metrics[] = [];
  // suffix sums: accounts with risk >= t are predicted "mule"
  let tpS = 0, fpS = 0;
  const tps = new Array<number>(102).fill(0), fps = new Array<number>(102).fill(0);
  for (let t = 100; t >= 0; t--) { tpS += pos[t]; fpS += neg[t]; tps[t] = tpS; fps[t] = fpS; }
  for (let t = 0; t <= 100; t++) sweep.push(metricsFrom({ tp: tps[t], fp: fps[t], fn: positives - tps[t], tn: negatives - fps[t] }, t));
  let best = sweep[0];
  for (const m of sweep) if (m.f1 > best.f1) best = m;
  // ROC-AUC by trapezoids over the threshold sweep (thresholds descend -> fpr ascends)
  let auc = 0, px = 0, py = 0;
  for (let t = 100; t >= 0; t--) { const x = safe(fps[t], negatives), y = safe(tps[t], positives); auc += ((x - px) * (y + py)) / 2; px = x; py = y; }
  auc += ((1 - px) * (1 + py)) / 2;
  return { evaluated, positives, negatives, missingFromDataset: missing, unlabelled, hist: { pos, neg }, sweep, best, auc };
}

// ---------------- weight tuner (train 70% / held-out 30%) ----------------
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const isTrainAccount = (s: string) => hash(s) % 10 < 7;

/** Recompute the 0..100 risk of every account for candidate weights (mirrors applyWeights, without mutating state). */
function riskFor(an: Analytics, w: Weights, out: Uint8Array) {
  const total = w.velocity + w.l1 + w.l2 + w.l3 + w.centrality || 1;
  const scale = 100 / total;
  for (let a = 0; a < an.nAcc; a++) {
    const s = (an.cVelocity[a] * w.velocity + an.cL1[a] * w.l1 + an.cL2[a] * w.l2 + an.cL3[a] * w.l3 + an.cCentrality[a] * w.centrality) * scale;
    let r = Math.round(Math.min(100, Math.max(0, s)));
    if (an.xFrac[a] >= 0.5 && an.inCount[a] + an.outCount[a] > 0 && r < 55) r = 55; // spec L3 floor
    out[a] = r;
  }
}

export interface TuneResult {
  weights: Weights;
  trainF1Before: number; trainF1After: number;
  heldOutBefore: Metrics; heldOutAfter: Metrics;
  rounds: number;
}

export function tuneWeights(ds: Dataset, an: Analytics, truth: GroundTruth, start: Weights): TuneResult {
  const buf = new Uint8Array(an.nAcc);
  const evalOn = (w: Weights, subset: (s: string) => boolean) => { riskFor(an, w, buf); return evaluate(ds, buf, truth, subset); };
  const train = (w: Weights) => evalOn(w, isTrainAccount).best.f1;
  let best: Weights = { ...start };
  let bestF1 = train(best);
  const before = bestF1;
  const keys: (keyof Weights)[] = ["velocity", "l1", "l2", "l3", "centrality"];
  let rounds = 0;
  for (let step = 10; step >= 2; step = step === 10 ? 5 : step === 5 ? 2 : 0) {
    let improved = true;
    while (improved && rounds < 40) {
      improved = false; rounds++;
      for (const k of keys) {
        for (const d of [step, -step]) {
          const cand: Weights = { ...best, [k]: Math.max(0, Math.min(60, best[k] + d)) };
          if (cand[k] === best[k] || cand.velocity + cand.l1 + cand.l2 + cand.l3 + cand.centrality <= 0) continue;
          const f = train(cand);
          if (f > bestF1 + 1e-4) { best = cand; bestF1 = f; improved = true; }
        }
      }
    }
  }
  const heldOut = (s: string) => !isTrainAccount(s);
  return {
    weights: best, trainF1Before: before, trainF1After: bestF1,
    heldOutBefore: evalOn(start, heldOut).best, heldOutAfter: evalOn(best, heldOut).best, rounds,
  };
}
