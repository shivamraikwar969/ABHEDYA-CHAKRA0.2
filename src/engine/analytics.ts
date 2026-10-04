import {
  type Analytics, type Dataset, type Weights, type ComponentBreakdown, type EvidenceItem, type PatternReport, type MuleScores, type MuleComponent,
    LAYER_L1, LAYER_L2, LAYER_L3, LAYER_NONE,
  XF_ANY, FLAG_HIGH_RISK_RECEIVER, FLAG_HIGH_RISK_SENDER, FLAG_STRUCTURING, FLAG_RAPID_PASSTHROUGH, FLAG_ROUND_LARGE,
} from "./types";

export const HIGH_RISK = 70;
export const MED_RISK = 40;
const HOUR = 3600000;
const PASS_WINDOW = 30 * 60000;
const SPEC_WINDOW = 15 * 60000;
const STRUCT_BANDS: [number, number][] = [[9000, 10000], [45000, 50000], [180000, 200000], [900000, 1000000]];
const CASHOUT_RE = /ATM|CASH|CRYPTO|WALLET|WITHDRAW|GIFT/i;

/** First index k in [lo,hi) of the time-ordered list `idx` with ts >= t. Rows with unparsable time sort first, so they are skipped. */
export function lowerBoundTs(ts: Float64Array, idx: Int32Array, lo: number, hi: number, t: number): number {
  while (lo < hi && isNaN(ts[idx[lo]])) lo++;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[idx[mid]] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const isStructured = (a: number) => STRUCT_BANDS.some(([lo, hi]) => a >= lo && a < hi);
export const isRoundLarge = (a: number) => a >= 10000 && a % 1000 === 0;

/** Sort row indices by timestamp using packed float keys (fast native sort). */
function timeOrder(ts: Float64Array): Int32Array {
  const n = ts.length;
  const bits = Math.max(1, Math.ceil(Math.log2(n + 1)));
  const mult = Math.pow(2, bits);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    const sec = isNaN(t) ? 0 : Math.max(0, Math.floor(t / 1000));
    keys[i] = sec * mult + i;
  }
  keys.sort();
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = keys[i] % mult;
  return order;
}

export function computeAnalytics(ds: Dataset): Analytics {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const n = ds.rowCount;
  const nAcc = ds.accounts.length;
  const { sender, receiver, amount, ts, mode, modes, xflag } = ds;
  const cashMode = new Uint8Array(modes.length);
  modes.forEach((m, i) => { if (CASHOUT_RE.test(m)) cashMode[i] = 1; });

  const order = timeOrder(ts);
  timings["Chronological index"] = performance.now() - t; t = performance.now();

  // CSR
  const outCount = new Int32Array(nAcc), inCount = new Int32Array(nAcc);
  for (let i = 0; i < n; i++) { outCount[sender[i]]++; inCount[receiver[i]]++; }
  const outStart = new Int32Array(nAcc + 1), inStart = new Int32Array(nAcc + 1);
  for (let a = 0; a < nAcc; a++) { outStart[a + 1] = outStart[a] + outCount[a]; inStart[a + 1] = inStart[a] + inCount[a]; }
  const outIdx = new Int32Array(n), inIdx = new Int32Array(n);
  const oPos = outStart.slice(0, nAcc), iPos = inStart.slice(0, nAcc);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    outIdx[oPos[sender[i]]++] = i;
    inIdx[iPos[receiver[i]]++] = i;
  }
  timings["CSR adjacency build"] = performance.now() - t; t = performance.now();

  const inSum = new Float64Array(nAcc), outSum = new Float64Array(nAcc);
  const uniqueIn = new Int32Array(nAcc), uniqueOut = new Int32Array(nAcc);
  const maxIn1h = new Int32Array(nAcc), txnPerDay = new Float32Array(nAcc);
  const passThroughFrac = new Float32Array(nAcc), medianLatencyMin = new Float32Array(nAcc);
  const roundFrac = new Float32Array(nAcc), structFrac = new Float32Array(nAcc), nightFrac = new Float32Array(nAcc);
  const burstFlag = new Uint8Array(nAcc), cashoutFrac = new Float32Array(nAcc);
  const pass90 = new Float32Array(nAcc), xFrac = new Float32Array(nAcc);
  const stamp = new Int32Array(nAcc).fill(-1);
  let maxDegree = 1;
  let merged = new Float64Array(64);
  const lat: number[] = [];

  for (let a = 0; a < nAcc; a++) {
    const os = outStart[a], oe = outStart[a + 1], is = inStart[a], ie = inStart[a + 1];
    const deg = (oe - os) + (ie - is);
    if (deg > maxDegree) maxDegree = deg;
    if (deg === 0) continue;
    // unique counterparties
    let uo = 0, ui = 0, osum = 0, isum = 0, cash = 0;
    for (let k = os; k < oe; k++) {
      const r = receiver[outIdx[k]];
      if (stamp[r] !== a) { stamp[r] = a; uo++; }
      const am = amount[outIdx[k]]; if (am >= 0) osum += am;
      if (cashMode[mode[outIdx[k]]]) cash++;
    }
    const stamp2 = a + nAcc; // second-phase stamp (distinct domain)
    for (let k = is; k < ie; k++) {
      const s = sender[inIdx[k]];
      if (stamp[s] !== stamp2) { stamp[s] = stamp2; ui++; }
      const am = amount[inIdx[k]]; if (am >= 0) isum += am;
    }
    uniqueOut[a] = uo; uniqueIn[a] = ui; outSum[a] = osum; inSum[a] = isum;
    cashoutFrac[a] = oe > os ? cash / (oe - os) : 0;
    // merged timeline
    if (merged.length < deg) merged = new Float64Array(deg * 2);
    let p = os, q = is, m = 0, round = 0, struct = 0, night = 0;
    while (p < oe || q < ie) {
      let i: number;
      if (q >= ie || (p < oe && ts[outIdx[p]] <= ts[inIdx[q]])) i = outIdx[p++];
      else i = inIdx[q++];
      const tt = ts[i];
      merged[m++] = isNaN(tt) ? -1 : tt;
      const am = amount[i];
      if (isRoundLarge(am)) round++;
      if (isStructured(am)) struct++;
      if (!isNaN(tt)) { const h = new Date(tt).getHours(); if (h < 5) night++; }
    }
    roundFrac[a] = round / deg; structFrac[a] = struct / deg; nightFrac[a] = night / deg;
    // sliding 1h window
    let best = 0, lo = 0;
    for (let hi = 0; hi < m; hi++) {
      if (merged[hi] < 0) { lo = hi + 1; continue; }
      while (merged[hi] - merged[lo] > HOUR) lo++;
      const c = hi - lo + 1; if (c > best) best = c;
    }
    maxIn1h[a] = best;
    let first = -1, last = -1;
    for (let k = 0; k < m; k++) if (merged[k] >= 0) { if (first < 0) first = merged[k]; last = merged[k]; }
    const spanDays = first >= 0 ? Math.max(1 / 24, (last - first) / 86400000) : 1;
    txnPerDay[a] = deg / Math.max(spanDays, 1);
    burstFlag[a] = deg >= 10 && first >= 0 && last - first <= 48 * HOUR ? 1 : 0;
    // pass-through latency: for each inflow, next outflow within window
    lat.length = 0;
    let passed = 0, pp = os;
    for (let k = is; k < ie; k++) {
      const ti = ts[inIdx[k]]; if (isNaN(ti)) continue;
      while (pp < oe && (isNaN(ts[outIdx[pp]]) || ts[outIdx[pp]] < ti)) pp++;
      if (pp < oe) {
        const d = ts[outIdx[pp]] - ti;
        lat.push(d / 60000);
        if (d <= PASS_WINDOW) passed++;
      }
    }
    passThroughFrac[a] = ie > is ? passed / (ie - is) : 0;
    if (lat.length) { lat.sort((x, y) => x - y); medianLatencyMin[a] = lat[Math.floor(lat.length / 2)]; } else medianLatencyMin[a] = -1;
    // Spec pass-through: share of inbound value re-dispersed across outflows within 15 minutes
    if (ie > is && oe > os) {
      let dispersed = 0, lo2 = os;
      for (let k = is; k < ie; k++) {
        const ti = ts[inIdx[k]]; if (isNaN(ti)) continue;
        while (lo2 < oe && (isNaN(ts[outIdx[lo2]]) || ts[outIdx[lo2]] < ti)) lo2++;
        let w = 0;
        for (let j = lo2; j < oe && ts[outIdx[j]] - ti <= SPEC_WINDOW; j++) w += Math.max(0, amount[outIdx[j]]);
        dispersed += Math.min(Math.max(0, amount[inIdx[k]]), w);
      }
      pass90[a] = isum > 0 ? Math.min(1, dispersed / isum) : 0;
    }
    // Cash-out signal share (foreign IP / headless device / crypto or wallet narration)
    let xc = 0;
    for (let k = os; k < oe; k++) if (xflag[outIdx[k]] & XF_ANY) xc++;
    for (let k = is; k < ie; k++) if (xflag[inIdx[k]] & XF_ANY) xc++;
    xFrac[a] = xc / deg;
  }
  timings["Behavioral feature extraction"] = performance.now() - t; t = performance.now();

  // Components
  const cVelocity = new Float32Array(nAcc), cL1 = new Float32Array(nAcc), cL2 = new Float32Array(nAcc), cL3 = new Float32Array(nAcc), cCentrality = new Float32Array(nAcc);
  const logMax = Math.log1p(maxDegree);
  for (let a = 0; a < nAcc; a++) {
    const deg = inCount[a] + outCount[a];
    if (deg === 0) continue;
    cVelocity[a] = clamp01(0.6 * clamp01((maxIn1h[a] - 1) / 9) + 0.4 * clamp01(txnPerDay[a] / 20) + (outCount[a] >= 2 ? 0.5 * pass90[a] : 0));
    cL1[a] = 0.55 * clamp01(uniqueIn[a] / 15) + 0.3 * clamp01(inCount[a] / 30) + 0.15 * (inCount[a] >= 5 && inSum[a] > 0 && inSum[a] / inCount[a] < 10000 ? 1 : 0);
    const flow = inSum[a] > 0 && outSum[a] > 0 ? Math.min(inSum[a], outSum[a]) / Math.max(inSum[a], outSum[a]) : 0;
    cL2[a] = 0.5 * clamp01(uniqueOut[a] / 10) + 0.5 * (inCount[a] > 0 ? flow : 0);
    cL3[a] = 0.35 * passThroughFrac[a] + 0.2 * clamp01(structFrac[a] * 3) + 0.15 * clamp01(roundFrac[a] * 2) + 0.1 * clamp01(nightFrac[a] * 2) + 0.1 * burstFlag[a] + 0.1 * cashoutFrac[a] + 0.5 * xFrac[a];
    cL3[a] = clamp01(cL3[a]);
    cCentrality[a] = 0.7 * (Math.log1p(deg) / logMax) + 0.3 * (inCount[a] > 0 && outCount[a] > 0 ? 1 : 0);
  }
  const risk = new Uint8Array(nAcc);
  const layer = new Uint8Array(nAcc);
  const an: Analytics = {
    nAcc, outStart, outIdx, inStart, inIdx, inCount, outCount, inSum, outSum, uniqueIn, uniqueOut, maxIn1h, txnPerDay,
    passThroughFrac, medianLatencyMin, roundFrac, structFrac, nightFrac, burstFlag, cashoutFrac, pass90, xFrac,
    cVelocity, cL1, cL2, cL3, cCentrality, risk, layer, txnFlags: new Uint8Array(n), flaggedRows: new Int32Array(0), maxDegree, timings,
  };
  timings["Component scoring"] = performance.now() - t;
  return an;
}

/** Recompute risk (0-100), layer classification and transaction flags for given weights. Mutates analytics in place. */
export function applyWeights(ds: Dataset, an: Analytics, w: Weights): void {
  const t = performance.now();
  const total = w.velocity + w.l1 + w.l2 + w.l3 + w.centrality || 1;
  const scale = 100 / total;
  const { nAcc, risk, layer } = an;
  for (let a = 0; a < nAcc; a++) {
    const s = (an.cVelocity[a] * w.velocity + an.cL1[a] * w.l1 + an.cL2[a] * w.l2 + an.cL3[a] * w.l3 + an.cCentrality[a] * w.centrality) * scale;
    risk[a] = Math.round(Math.min(100, Math.max(0, s)));
    // Spec L3: terminal cash-out nodes (foreign IP / headless client / crypto-wallet narration) get a risk floor of 55
    if (an.xFrac[a] >= 0.5 && an.inCount[a] + an.outCount[a] > 0) { layer[a] = LAYER_L3; if (risk[a] < 55) risk[a] = 55; continue; }
    // Layer classification
    const l1 = an.cL1[a], l2 = an.cL2[a], l3 = an.cL3[a];
    if (risk[a] < MED_RISK) layer[a] = LAYER_NONE;
    else if (an.pass90[a] >= 0.9 && an.uniqueOut[a] >= 3 && an.uniqueOut[a] <= 7 && an.uniqueIn[a] < 3) layer[a] = LAYER_L2;
    else if (l1 >= l2 && l1 >= l3 && an.uniqueIn[a] >= 3) layer[a] = LAYER_L1;
    else if (l2 >= l3 && an.uniqueOut[a] >= 2 && an.inCount[a] > 0) layer[a] = LAYER_L2;
    else if (l3 >= 0.25) layer[a] = LAYER_L3;
    else layer[a] = an.uniqueIn[a] >= an.uniqueOut[a] ? LAYER_L1 : LAYER_L2;
  }
  // txn flags
  const n = ds.rowCount;
  const flags = an.txnFlags;
  const { sender, receiver, amount, ts } = ds;
  let count = 0;
  for (let i = 0; i < n; i++) {
    let f = 0;
    if (risk[receiver[i]] >= HIGH_RISK) f |= FLAG_HIGH_RISK_RECEIVER;
    if (risk[sender[i]] >= HIGH_RISK) f |= FLAG_HIGH_RISK_SENDER;
    const a = amount[i];
    if (isStructured(a)) f |= FLAG_STRUCTURING;
    if (isRoundLarge(a) && a >= 50000) f |= FLAG_ROUND_LARGE;
    flags[i] = f;
    if (f) count++;
  }
  // rapid pass-through: outflow within 30 min after an inflow at the sender with ≥ 80% amount
  for (let a = 0; a < nAcc; a++) {
    const os = an.outStart[a], oe = an.outStart[a + 1], is = an.inStart[a], ie = an.inStart[a + 1];
    if (oe === os || ie === is) continue;
    let q = is;
    for (let k = os; k < oe; k++) {
      const o = an.outIdx[k]; const to = ts[o]; if (isNaN(to)) continue;
      while (q < ie && (isNaN(ts[an.inIdx[q]]) || ts[an.inIdx[q]] <= to)) q++;
      // look at the latest inflow before to
      for (let j = q - 1; j >= is && j >= q - 6; j--) {
        const ii = an.inIdx[j]; const ti = ts[ii]; if (isNaN(ti)) continue;
        if (to - ti <= PASS_WINDOW && amount[o] >= 0.8 * amount[ii] && amount[o] <= amount[ii] * 1.02) {
          if (!flags[o]) count++;
          flags[o] |= FLAG_RAPID_PASSTHROUGH; break;
        }
        if (to - ti > PASS_WINDOW) break;
      }
    }
  }
  const flagged = new Int32Array(count);
  let c = 0;
  for (let i = 0; i < n && c < count; i++) if (flags[i]) flagged[c++] = i;
  an.flaggedRows = flagged;
  an.timings["Risk index + flagging"] = performance.now() - t;
}

export function topAccounts(an: Analytics, limit: number, minDeg = 1): number[] {
  const cand: number[] = [];
  for (let a = 0; a < an.nAcc; a++) if (an.inCount[a] + an.outCount[a] >= minDeg && an.risk[a] >= MED_RISK) cand.push(a);
  cand.sort((x, y) => an.risk[y] - an.risk[x] || (an.inCount[y] + an.outCount[y]) - (an.inCount[x] + an.outCount[x]));
  return cand.slice(0, limit);
}

export function riskColor(r: number): string {
  if (r >= HIGH_RISK) return "#ef4444";
  if (r >= MED_RISK) return "#f59e0b";
  return "#06b6d4";
}

const fmtMin = (m: number) => (m < 0 ? "n/a" : m < 60 ? `${m.toFixed(1)} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);

/** Full transparent breakdown with evidence trace for an account. */
export function breakdown(ds: Dataset, an: Analytics, a: number, w: Weights): ComponentBreakdown[] {
  const total = w.velocity + w.l1 + w.l2 + w.l3 + w.centrality || 1;
  const scale = 100 / total;
  const os = an.outStart[a], oe = an.outStart[a + 1], is = an.inStart[a], ie = an.inStart[a + 1];
  const outs = Array.from(an.outIdx.subarray(os, oe));
  const ins = Array.from(an.inIdx.subarray(is, ie));
  const { ts, amount } = ds;

  // velocity evidence: densest 1h window rows
  const all = [...outs, ...ins].filter((i) => !isNaN(ts[i])).sort((x, y) => ts[x] - ts[y]);
  let bestLo = 0, bestHi = -1, lo = 0;
  for (let hi = 0; hi < all.length; hi++) {
    while (ts[all[hi]] - ts[all[lo]] > HOUR) lo++;
    if (hi - lo > bestHi - bestLo) { bestLo = lo; bestHi = hi; }
  }
  const burstRows = bestHi >= 0 ? all.slice(bestLo, bestHi + 1) : [];

  const passRows: number[] = [], passPairs: number[] = [];
  let q = os;
  for (const ii of ins) {
    const ti = ts[ii]; if (isNaN(ti)) continue;
    while (q < oe && (isNaN(ts[an.outIdx[q]]) || ts[an.outIdx[q]] < ti)) q++;
    if (q < oe && ts[an.outIdx[q]] - ti <= PASS_WINDOW) { passRows.push(an.outIdx[q]); passPairs.push(ii); }
  }
  const structRows = [...outs, ...ins].filter((i) => isStructured(amount[i]));
  const roundRows = [...outs, ...ins].filter((i) => isRoundLarge(amount[i]));
  const nightRows = [...outs, ...ins].filter((i) => !isNaN(ts[i]) && new Date(ts[i]).getHours() < 5);
  const cashRows = outs.filter((i) => CASHOUT_RE.test(ds.modes[ds.mode[i]]));
  const ev = (type: string, detail: string, rows: number[]): EvidenceItem => ({ type, detail, rows: rows.slice(0, 60) });

  return [
    {
      key: "velocity", label: "Velocity", value: an.cVelocity[a], weight: w.velocity, points: an.cVelocity[a] * w.velocity * scale,
      reasoning: [
        `Peak of ${an.maxIn1h[a]} transactions within any 60-minute window (saturates at 10) → ${(clamp01((an.maxIn1h[a] - 1) / 9) * 100).toFixed(0)}% × 0.6`,
        `${an.txnPerDay[a].toFixed(2)} transactions per active day (saturates at 20) → ${(clamp01(an.txnPerDay[a] / 20) * 100).toFixed(0)}% × 0.4`,
      ],
      evidence: [ev("Peak 1h burst window", `${burstRows.length} txns in densest hour`, burstRows)],
    },
    {
      key: "l1", label: "L1 Collector (fan-in)", value: an.cL1[a], weight: w.l1, points: an.cL1[a] * w.l1 * scale,
      reasoning: [
        `${an.uniqueIn[a]} unique senders (saturates at 15) → ${(clamp01(an.uniqueIn[a] / 15) * 100).toFixed(0)}% × 0.55`,
        `${an.inCount[a]} inbound transactions (saturates at 30) → ${(clamp01(an.inCount[a] / 30) * 100).toFixed(0)}% × 0.3`,
        `Mean inbound amount ₹${an.inCount[a] ? (an.inSum[a] / an.inCount[a]).toFixed(0) : 0} ${an.inCount[a] >= 5 && an.inSum[a] / an.inCount[a] < 10000 ? "< ₹10k with ≥5 inflows → micro-collection pattern (+0.15)" : "(micro-collection not triggered)"}`,
      ],
      evidence: [ev("Inbound transactions", `${ins.length} inflows from ${an.uniqueIn[a]} senders`, ins)],
    },
    {
      key: "l2", label: "L2 Distributor (fan-out / pass-through)", value: an.cL2[a], weight: w.l2, points: an.cL2[a] * w.l2 * scale,
      reasoning: [
        `${an.uniqueOut[a]} unique receivers (saturates at 10) → ${(clamp01(an.uniqueOut[a] / 10) * 100).toFixed(0)}% × 0.5`,
        `Flow balance in ₹${an.inSum[a].toFixed(0)} vs out ₹${an.outSum[a].toFixed(0)} → pass-through ratio ${(an.inSum[a] > 0 && an.outSum[a] > 0 ? Math.min(an.inSum[a], an.outSum[a]) / Math.max(an.inSum[a], an.outSum[a]) : 0).toFixed(2)} × 0.5`,
      ],
      evidence: [ev("Outbound distribution", `${outs.length} outflows to ${an.uniqueOut[a]} receivers`, outs)],
    },
    {
      key: "l3", label: "L3 Indicators (typology signals)", value: an.cL3[a], weight: w.l3, points: an.cL3[a] * w.l3 * scale,
      reasoning: [
        `Rapid pass-through: ${(an.passThroughFrac[a] * 100).toFixed(0)}% of inflows followed by an outflow ≤30 min (median latency ${fmtMin(an.medianLatencyMin[a])}) × 0.35`,
        `Structuring: ${(an.structFrac[a] * 100).toFixed(1)}% of amounts sit just under ₹10k/₹50k/₹2L/₹10L thresholds × 0.2`,
        `Round amounts ≥₹10k: ${(an.roundFrac[a] * 100).toFixed(1)}% × 0.15`,
        `Night activity (00:00–05:00): ${(an.nightFrac[a] * 100).toFixed(1)}% × 0.1`,
        `Burst account (≥10 txns inside 48h): ${an.burstFlag[a] ? "YES" : "no"} × 0.1`,
        `Cash-out channels (ATM/CASH/WALLET/CRYPTO): ${(an.cashoutFrac[a] * 100).toFixed(0)}% of outflows × 0.1`,
      ],
      evidence: [
        ev("Rapid pass-through outflows", `${passRows.length} outflows within 30 min of an inflow`, passRows),
        ev("Pass-through source inflows", `${passPairs.length} matched inflows`, passPairs),
        ev("Structured amounts", `${structRows.length} txns just below thresholds`, structRows),
        ev("Round large amounts", `${roundRows.length} txns`, roundRows),
        ev("Night-time transactions", `${nightRows.length} txns`, nightRows),
        ev("Cash-out channel outflows", `${cashRows.length} txns`, cashRows),
      ].filter((e) => e.rows.length),
    },
    {
      key: "centrality", label: "Network Centrality", value: an.cCentrality[a], weight: w.centrality, points: an.cCentrality[a] * w.centrality * scale,
      reasoning: [
        `Degree ${an.inCount[a] + an.outCount[a]} vs network max ${an.maxDegree} (log-scaled) × 0.7`,
        `Bridge node (has both inflows and outflows): ${an.inCount[a] > 0 && an.outCount[a] > 0 ? "YES" : "no"} × 0.3`,
      ],
      evidence: [ev("All connected transactions", `${ins.length + outs.length} txns`, [...ins, ...outs])],
    },
  ];
}

/** Coefficient-of-variation based amount clustering: 1 = all amounts identical, 0 = widely spread. */
export function amountClusterScore(amounts: ArrayLike<number>): number {
  const n = amounts.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += amounts[i];
  const mean = sum / n;
  if (!(mean > 0)) return 0;
  let v = 0;
  for (let i = 0; i < n; i++) v += (amounts[i] - mean) * (amounts[i] - mean);
  return clamp01(1 - Math.sqrt(v / n) / mean);
}


// =====================================================================================
//  MULE-ACCOUNT SCORE  (deterministic; independent of the tunable Weights / calibration)
//  Each signal i has a fixed ceiling k_i (the most that signal alone can contribute) and a 0..1 strength c_i.
//  Signals are combined as  score = 100 * (1 - prod(1 - k_i * c_i))  - monotone, bounded, and two independent
//  typologies on one account reinforce each other. Same dataset -> same score.
// =====================================================================================
export const MULE_WEIGHTS = {
  qiqo: 0.6, // quick-in quick-out forwarding
  ring: 0.6, // member of a layering cycle
  fanIn: 0.5, // smurfing collector
  fanOut: 0.4, // smurfing distributor
  velocity: 0.35, // transaction-frequency velocity (burst density + per-day rate)
  clustering: 0.3, // amount clustering (near-identical or just-below-threshold amounts)
} as const;
export const MULE_FLAG_THRESHOLD = 40;

const MULE_LABELS: Record<keyof typeof MULE_WEIGHTS, string> = {
  qiqo: "Quick-in / quick-out", ring: "Layering ring membership", fanIn: "Fan-in smurfing", fanOut: "Fan-out smurfing",
  velocity: "Transaction-frequency velocity", clustering: "Amount clustering",
};

/** Strongest amount-clustering signal for an account: identical-amount cluster, or share sitting just under reporting thresholds. */
function accountClustering(ds: Dataset, an: Analytics, a: number): number {
  const rows: number[] = [];
  for (let k = an.inStart[a]; k < an.inStart[a + 1]; k++) rows.push(an.inIdx[k]);
  for (let k = an.outStart[a]; k < an.outStart[a + 1]; k++) rows.push(an.outIdx[k]);
  if (rows.length < 3) return 0;
  const amts = rows.map((r) => ds.amount[r]).filter((x) => x > 0);
  if (amts.length < 3) return 0;
  // modal log-bucket (5% wide): share of transactions inside the densest bucket
  const bucket = new Map<number, number>();
  let top = 0;
  for (const x of amts) { const b = Math.round(Math.log(x) / 0.0488); const c = (bucket.get(b) ?? 0) + 1; bucket.set(b, c); if (c > top) top = c; }
  return clamp01(Math.max(top / amts.length, an.structFrac[a] * 1.5, amountClusterScore(amts) * 0.8));
}

export function computeMuleScores(ds: Dataset, an: Analytics, pr: PatternReport): MuleScores {
  const t0 = performance.now();
  const score = new Uint8Array(an.nAcc);
  const explain = new Map<number, MuleComponent[]>();
  const best: Record<number, { qiqo: number; ring: number; fanIn: number; fanOut: number }> = {};
  const slot = (a: number) => (best[a] ??= { qiqo: 0, ring: 0, fanIn: 0, fanOut: 0 });
  for (const h of pr.hits) {
    for (const a of h.accounts) {
      const s = slot(a);
      if (h.kind === "QUICK_IN_QUICK_OUT") s.qiqo = Math.max(s.qiqo, h.score);
      else if (h.kind === "LAYERING_RING") s.ring = Math.max(s.ring, h.score);
      else if (h.kind === "FAN_IN") s.fanIn = Math.max(s.fanIn, h.score);
      else s.fanOut = Math.max(s.fanOut, h.score);
    }
  }
  for (let a = 0; a < an.nAcc; a++) {
    if (an.inCount[a] + an.outCount[a] === 0) continue;
    const m = pr.mask[a];
    const candidate = m !== 0 || an.risk[a] >= MED_RISK || an.cVelocity[a] >= 0.3;
    const p = best[a];
    const comp = {
      qiqo: p?.qiqo ?? 0, ring: p?.ring ?? 0, fanIn: p?.fanIn ?? 0, fanOut: p?.fanOut ?? 0,
      velocity: an.cVelocity[a],
      clustering: candidate ? accountClustering(ds, an, a) : 0,
    };
    let keep = 1;
    for (const k of Object.keys(MULE_WEIGHTS) as (keyof typeof MULE_WEIGHTS)[]) keep *= 1 - MULE_WEIGHTS[k] * comp[k];
    score[a] = Math.round((1 - keep) * 100);
    if (candidate) {
      explain.set(a, (Object.keys(MULE_WEIGHTS) as (keyof typeof MULE_WEIGHTS)[]).map((k) => ({
        key: k, label: MULE_LABELS[k], value: comp[k], weight: MULE_WEIGHTS[k], points: comp[k] * MULE_WEIGHTS[k] * 100, // standalone ceiling-weighted strength
        note: k === "velocity" ? `${an.maxIn1h[a]} txns in peak hour, ${an.txnPerDay[a].toFixed(1)}/day` : k === "clustering" ? `structuring ${(an.structFrac[a] * 100).toFixed(0)}%` : comp[k] > 0 ? "pattern detected" : "not observed",
      })));
    }
  }
  return { score, explain, ms: performance.now() - t0 };
}

const muleCache = new WeakMap<Analytics, MuleScores>();
export function getMuleScores(ds: Dataset, an: Analytics, pr: PatternReport): MuleScores {
  let m = muleCache.get(an);
  if (!m) { m = computeMuleScores(ds, an, pr); muleCache.set(an, m); }
  return m;
}
