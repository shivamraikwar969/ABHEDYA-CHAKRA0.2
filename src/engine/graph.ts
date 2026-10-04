import {
  PAT_FAN_IN, PAT_FAN_OUT, PAT_QIQO, PAT_RING,
  type Analytics, type Dataset, type PatternHit, type PatternKind, type PatternReport,
} from "./types";
import type { GEdge, GNode } from "@/components/ForceGraph";
import { amountClusterScore, lowerBoundTs, topAccounts } from "./analytics";

export interface SubGraph { nodes: GNode[]; edges: GEdge[]; truncated: boolean; }

function mkNode(ds: Dataset, an: Analytics, a: number): GNode {
  return { id: a, label: ds.accounts[a], risk: an.risk[a], degree: an.inCount[a] + an.outCount[a], layer: an.layer[a] };
}
function mkEdge(ds: Dataset, an: Analytics, row: number, hop?: number): GEdge {
  return { source: ds.sender[row], target: ds.receiver[row], row, txnId: ds.txnIds[row], amount: ds.amount[row], ts: ds.ts[row], flagged: an.txnFlags[row] !== 0, hop } as GEdge;
}

function finalize(ds: Dataset, an: Analytics, nodeSet: Set<number>, rows: number[], truncated: boolean): SubGraph {
  const nodes = Array.from(nodeSet).map((a) => mkNode(ds, an, a));
  const edges = rows.map((r) => mkEdge(ds, an, r));
  return { nodes, edges, truncated };
}

/** Edges among a node set, pulled from CSR out-lists (no full scan). */
function edgesWithin(ds: Dataset, an: Analytics, nodeSet: Set<number>, maxEdges: number): { rows: number[]; truncated: boolean } {
  const rows: number[] = [];
  const seenPair = new Set<string>();
  let truncated = false;
  for (const a of nodeSet) {
    for (let k = an.outStart[a]; k < an.outStart[a + 1]; k++) {
      const r = an.outIdx[k];
      const t = ds.receiver[r];
      if (!nodeSet.has(t) || t === a) continue;
      // keep up to 3 parallel edges per pair to limit clutter
      const key = a + ">" + t;
      const c = seenPair.has(key + "#2") ? 3 : seenPair.has(key + "#1") ? 2 : seenPair.has(key) ? 1 : 0;
      if (c >= 3) continue;
      seenPair.add(c === 0 ? key : key + "#" + c);
      rows.push(r);
      if (rows.length >= maxEdges) { truncated = true; return { rows, truncated }; }
    }
  }
  return { rows, truncated };
}

export function buildFull(ds: Dataset, an: Analytics, maxNodes = 240, maxEdges = 900): SubGraph {
  const seeds = topAccounts(an, 80, 2);
  const nodeSet = new Set<number>(seeds);
  // expand with neighbours of seeds (highest-amount first within CSR order)
  outer: for (const s of seeds) {
    const lists: [Int32Array, Int32Array, boolean][] = [[an.outStart, an.outIdx, true], [an.inStart, an.inIdx, false]];
    for (const [start, idx, isOut] of lists) {
      let taken = 0;
      for (let k = start[s]; k < start[s + 1] && taken < 6; k++) {
        const r = idx[k]; const other = isOut ? ds.receiver[r] : ds.sender[r];
        if (!nodeSet.has(other)) { nodeSet.add(other); taken++; }
        if (nodeSet.size >= maxNodes) break outer;
      }
    }
  }
  // if the dataset has no risky seeds, fall back to highest-degree accounts
  if (nodeSet.size < 10) {
    const byDeg = Array.from({ length: an.nAcc }, (_, i) => i).sort((x, y) => (an.inCount[y] + an.outCount[y]) - (an.inCount[x] + an.outCount[x])).slice(0, maxNodes);
    byDeg.forEach((a) => nodeSet.add(a));
  }
  const { rows, truncated } = edgesWithin(ds, an, nodeSet, maxEdges);
  const connected = new Set<number>();
  rows.forEach((r) => { connected.add(ds.sender[r]); connected.add(ds.receiver[r]); });
  return finalize(ds, an, connected.size ? connected : nodeSet, rows, truncated || an.nAcc > nodeSet.size);
}

export function buildFlagged(ds: Dataset, an: Analytics, maxEdges = 600): SubGraph {
  const fr = an.flaggedRows;
  const list = Array.from(fr.subarray(0, Math.min(fr.length, 50000)));
  // prioritise by severity: more flag bits and higher endpoint risk first
  list.sort((x, y) => (popcount(an.txnFlags[y]) + Math.max(an.risk[ds.sender[y]], an.risk[ds.receiver[y]]) / 100) - (popcount(an.txnFlags[x]) + Math.max(an.risk[ds.sender[x]], an.risk[ds.receiver[x]]) / 100));
  const rows = list.slice(0, maxEdges);
  const nodeSet = new Set<number>();
  rows.forEach((r) => { nodeSet.add(ds.sender[r]); nodeSet.add(ds.receiver[r]); });
  return finalize(ds, an, nodeSet, rows, fr.length > rows.length);
}

export function buildEgo(ds: Dataset, an: Analytics, acc: number, perNode = 20, maxEdges = 500): SubGraph {
  const nodeSet = new Set<number>([acc]);
  const rows: number[] = [];
  const rowSet = new Set<number>();
  let truncated = false;
  const add = (r: number) => { if (!rowSet.has(r)) { rowSet.add(r); rows.push(r); nodeSet.add(ds.sender[r]); nodeSet.add(ds.receiver[r]); } };
  const take = (a: number, start: Int32Array, idx: Int32Array, limit: number) => {
    const n = start[a + 1] - start[a];
    if (n > limit) truncated = true;
    const picked: number[] = [];
    for (let k = start[a]; k < start[a + 1] && picked.length < limit; k++) picked.push(idx[k]);
    return picked;
  };
  const hop1 = [...take(acc, an.outStart, an.outIdx, perNode * 2), ...take(acc, an.inStart, an.inIdx, perNode * 2)];
  hop1.forEach(add);
  const frontier = Array.from(new Set(hop1.map((r) => (ds.sender[r] === acc ? ds.receiver[r] : ds.sender[r]))));
  for (const f of frontier) {
    if (rows.length >= maxEdges) { truncated = true; break; }
    take(f, an.outStart, an.outIdx, 6).forEach(add);
    take(f, an.inStart, an.inIdx, 3).forEach(add);
  }
  return finalize(ds, an, nodeSet, rows.slice(0, maxEdges), truncated || rows.length > maxEdges);
}

export interface Filters { txnId: string; account: string; mode: string; minAmount: number; }

export function buildFiltered(ds: Dataset, an: Analytics, f: Filters, maxEdges = 800): SubGraph & { matches: number } {
  const txn = f.txnId.trim().toLowerCase();
  const acc = f.account.trim().toLowerCase();
  const modeIdx = f.mode ? ds.modes.indexOf(f.mode) : -1;
  const rows: number[] = [];
  let matches = 0;
  // account filter: use dictionary scan to find matching accounts, then CSR
  if (acc && !txn) {
    const accs: number[] = [];
    for (let a = 0; a < ds.accounts.length && accs.length < 200; a++) if (ds.accounts[a].toLowerCase().includes(acc)) accs.push(a);
    const seen = new Set<number>();
    for (const a of accs) {
      for (const [start, idx] of [[an.outStart, an.outIdx], [an.inStart, an.inIdx]] as const) {
        for (let k = start[a]; k < start[a + 1]; k++) {
          const r = idx[k];
          if (seen.has(r)) continue;
          if (modeIdx >= 0 && ds.mode[r] !== modeIdx) continue;
          if (!(ds.amount[r] >= f.minAmount)) continue;
          seen.add(r); matches++;
          if (rows.length < maxEdges) rows.push(r);
        }
      }
    }
  } else {
    for (let r = 0; r < ds.rowCount; r++) {
      if (txn && !ds.txnIds[r].toLowerCase().includes(txn)) continue;
      if (modeIdx >= 0 && ds.mode[r] !== modeIdx) continue;
      if (!(ds.amount[r] >= f.minAmount)) continue;
      if (acc && !(ds.accounts[ds.sender[r]].toLowerCase().includes(acc) || ds.accounts[ds.receiver[r]].toLowerCase().includes(acc))) continue;
      matches++;
      if (rows.length < maxEdges) rows.push(r);
      else if (!txn && matches > maxEdges * 50) break; // bail out for very broad filters
    }
  }
  const nodeSet = new Set<number>();
  rows.forEach((r) => { nodeSet.add(ds.sender[r]); nodeSet.add(ds.receiver[r]); });
  return { ...finalize(ds, an, nodeSet, rows, matches > rows.length), matches };
}

export interface ChronoNode { row: number; depth: number; children: ChronoNode[]; }

/** Chronological outflow tree from an account: each outflow expands into subsequent outflows of its receiver. */
export function chronoTree(ds: Dataset, an: Analytics, acc: number, depth = 3, perNode = 8): { roots: ChronoNode[]; inflows: number[] } {
  const visited = new Set<number>([acc]);
  const build = (a: number, after: number, d: number): ChronoNode[] => {
    if (d > depth) return [];
    const out: ChronoNode[] = [];
    for (let k = an.outStart[a]; k < an.outStart[a + 1] && out.length < perNode; k++) {
      const r = an.outIdx[k];
      if (!isNaN(ds.ts[r]) && ds.ts[r] < after) continue;
      const to = ds.receiver[r];
      const node: ChronoNode = { row: r, depth: d, children: [] };
      if (!visited.has(to)) { visited.add(to); node.children = build(to, isNaN(ds.ts[r]) ? after : ds.ts[r], d + 1); }
      out.push(node);
    }
    return out;
  };
  const inflows: number[] = [];
  for (let k = an.inStart[acc]; k < an.inStart[acc + 1] && inflows.length < 40; k++) inflows.push(an.inIdx[k]);
  return { roots: build(acc, -Infinity, 1), inflows };
}

function popcount(x: number) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

// =====================================================================================
//  FRAUD PATTERN DETECTION  (deterministic, bounded, no randomness)
//  Layering rings · fan-in / fan-out smurfing · quick-in quick-out velocity traps.
//  All detectors read the time-ordered CSR adjacency, so cost is O(edges touched), never O(n^2).
// =====================================================================================
export const PATTERN_CFG = {
  fanWindowMs: 24 * 3600000, // smurfing window
  fanMinCounterparties: 8, // distinct senders (fan-in) / receivers (fan-out) inside the window
  qiqoWindowMs: 15 * 60000, // "quick" = outflow within 15 min of the inflow
  qiqoMinMatches: 3, // matched in->out pairs to call it a trap
  qiqoMinRetention: 0.7, // outflow must carry >=70% of the inflow (and <=102%)
  ringMinLen: 3,
  ringMaxLen: 6,
  ringWindowMs: 72 * 3600000, // whole cycle must complete inside 72h
  ringMinRetention: 0.5, // every hop must forward >=50% of the previous hop's amount
  ringBranch: 10, // outflows explored per node
  ringStartBudget: 4000, // edge examinations per start node
  ringGlobalBudget: 4_000_000, // edge examinations in total
  ringMaxHits: 300,
  evidenceCap: 60,
} as const;

const clampUnit = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Fan-in (dir=in) / fan-out (dir=out): >=N distinct counterparties inside a sliding window, scored with amount clustering. */
function detectFan(ds: Dataset, an: Analytics, a: number, dir: "in" | "out"): PatternHit | null {
  const start = dir === "in" ? an.inStart : an.outStart, idx = dir === "in" ? an.inIdx : an.outIdx;
  const s = start[a], e = start[a + 1];
  if (e - s < PATTERN_CFG.fanMinCounterparties) return null;
  if ((dir === "in" ? an.uniqueIn[a] : an.uniqueOut[a]) < PATTERN_CFG.fanMinCounterparties) return null;
  const { ts } = ds;
  const cp = dir === "in" ? ds.sender : ds.receiver;
  const live = new Map<number, number>();
  let lo = s, bestLo = -1, bestHi = -1, bestDistinct = 0;
  for (let hi = s; hi < e; hi++) {
    const th = ts[idx[hi]];
    if (isNaN(th)) { lo = hi + 1; live.clear(); continue; }
    live.set(cp[idx[hi]], (live.get(cp[idx[hi]]) ?? 0) + 1);
    while (th - ts[idx[lo]] > PATTERN_CFG.fanWindowMs) {
      const c = cp[idx[lo]], k = live.get(c)! - 1;
      if (k <= 0) live.delete(c); else live.set(c, k);
      lo++;
    }
    if (live.size > bestDistinct) { bestDistinct = live.size; bestLo = lo; bestHi = hi; }
  }
  if (bestDistinct < PATTERN_CFG.fanMinCounterparties) return null;
  const rows = Array.from(idx.subarray(bestLo, bestHi + 1));
  const amts = rows.map((r) => Math.max(0, ds.amount[r]));
  const total = amts.reduce((x, y) => x + y, 0);
  const cluster = amountClusterScore(amts);
  // counter-direction forwarding: how much of the window's value leaves (fan-in) / arrived (fan-out) within 24h
  const opp = dir === "in" ? an.outStart : an.inStart, oppIdx = dir === "in" ? an.outIdx : an.inIdx;
  const t0 = ts[idx[bestLo]], t1 = ts[idx[bestHi]];
  let forwarded = 0;
  const k0 = lowerBoundTs(ts, oppIdx, opp[a], opp[a + 1], dir === "in" ? t0 : t0 - PATTERN_CFG.fanWindowMs);
  for (let k = k0; k < opp[a + 1] && ts[oppIdx[k]] <= (dir === "in" ? t1 + PATTERN_CFG.fanWindowMs : t1); k++) forwarded += Math.max(0, ds.amount[oppIdx[k]]);
  const fwd = total > 0 ? clampUnit(forwarded / total) : 0;
  const score = clampUnit(0.5 * clampUnit(bestDistinct / 20) + 0.3 * cluster + 0.2 * fwd);
  const kind: PatternKind = dir === "in" ? "FAN_IN" : "FAN_OUT";
  return {
    kind, accounts: [a], rows: rows.slice(0, PATTERN_CFG.evidenceCap), score, totalAmount: total, startTs: t0, endTs: t1,
    detail: `${bestDistinct} distinct ${dir === "in" ? "senders" : "receivers"} in ${((t1 - t0) / 3600000).toFixed(1)}h; amount clustering ${(cluster * 100).toFixed(0)}%; ${(fwd * 100).toFixed(0)}% of value forwarded within 24h`,
  };
}

/** Quick-in quick-out: inflow forwarded (>=70%) within 15 minutes, repeated. Each outflow is matched at most once. */
function detectQiqo(ds: Dataset, an: Analytics, a: number): PatternHit | null {
  const os = an.outStart[a], oe = an.outStart[a + 1], is = an.inStart[a], ie = an.inStart[a + 1];
  if (oe === os || ie === is) return null;
  const { ts, amount } = ds;
  const ins: number[] = [], outs: number[] = [], dwell: number[] = [];
  let pp = os, ret = 0, inVal = 0;
  for (let k = is; k < ie; k++) {
    const ri = an.inIdx[k], ti = ts[ri];
    if (isNaN(ti) || !(amount[ri] > 0)) continue;
    while (pp < oe && (isNaN(ts[an.outIdx[pp]]) || ts[an.outIdx[pp]] < ti)) pp++;
    for (let q = pp; q < oe && ts[an.outIdx[q]] - ti <= PATTERN_CFG.qiqoWindowMs; q++) {
      const ro = an.outIdx[q];
      if (ds.receiver[ro] === ds.sender[ri]) continue; // bounce-back is a refund, not forwarding
      if (amount[ro] >= PATTERN_CFG.qiqoMinRetention * amount[ri] && amount[ro] <= amount[ri] * 1.02) {
        ins.push(ri); outs.push(ro); dwell.push((ts[ro] - ti) / 60000);
        ret += amount[ro] / amount[ri]; inVal += amount[ri];
        pp = q + 1; // consume this outflow
        break;
      }
    }
  }
  const m = dwell.length;
  const medianDwell = m ? [...dwell].sort((x, y) => x - y)[m >> 1] : 0;
  if (m < PATTERN_CFG.qiqoMinMatches && !(m >= 2 && medianDwell <= 5)) return null;
  const speed = 1 - clampUnit(medianDwell / (PATTERN_CFG.qiqoWindowMs / 60000));
  const score = clampUnit(0.5 * clampUnit(m / 8) + 0.3 * speed + 0.2 * (ret / m));
  const rows = [...ins, ...outs];
  const all = rows.map((r) => ts[r]);
  return {
    kind: "QUICK_IN_QUICK_OUT", accounts: [a], rows: rows.slice(0, PATTERN_CFG.evidenceCap), score, totalAmount: inVal,
    startTs: Math.min(...all), endTs: Math.max(...all),
    detail: `${m} inflow(s) forwarded within 15 min (median dwell ${medianDwell.toFixed(1)} min, mean retention ${((ret / m) * 100).toFixed(0)}%)`,
  };
}

/**
 * Layering rings: time-respecting directed cycles of length 3..6 where every hop forwards >=50% of the previous hop
 * and the whole loop closes inside 72h. A cycle is only searched from its smallest account id (no duplicates).
 * Bounded by per-start and global edge-examination budgets (reported via `truncated`).
 */
function detectRings(ds: Dataset, an: Analytics, out: PatternHit[]): boolean {
  const { ts, amount, receiver } = ds;
  const C = PATTERN_CFG;
  let global = 0, truncated = false;
  const seen = new Set<string>();
  const path: number[] = []; // accounts
  const rowsP: number[] = [];
  const eligible = (a: number) => an.inCount[a] > 0 && an.outCount[a] > 0 && an.outCount[a] <= 400;

  for (let s = 0; s < an.nAcc && out.length < C.ringMaxHits; s++) {
    if (!eligible(s)) continue;
    if (global > C.ringGlobalBudget) { truncated = true; break; }
    let local = 0;
    path.length = 0; rowsP.length = 0; path.push(s);
    const dfs = (cur: number, minTs: number, firstTs: number, prevAmt: number): void => {
      if (local > C.ringStartBudget || out.length >= C.ringMaxHits) { if (local > C.ringStartBudget) truncated = true; return; }
      const oe = an.outStart[cur + 1];
      let k = lowerBoundTs(ts, an.outIdx, an.outStart[cur], oe, minTs);
      let taken = 0;
      for (; k < oe && taken < C.ringBranch; k++) {
        const r = an.outIdx[k]; local++; global++;
        const t = ts[r];
        if (isNaN(t)) continue;
        if (isFinite(firstTs) && t - firstTs > C.ringWindowMs) break;
        const to = receiver[r];
        if (to === cur) continue;
        if (isFinite(prevAmt) && !(amount[r] >= C.ringMinRetention * prevAmt)) continue;
        if (to === s) {
          if (path.length >= C.ringMinLen) {
            const key = path.join(">");
            if (!seen.has(key)) {
              seen.add(key);
              const rows = [...rowsP, r];
              const amts = rows.map((x) => amount[x]);
              const retention = Math.min(...amts) / Math.max(...amts);
              const span = t - ts[rows[0]];
              const score = clampUnit(0.4 * clampUnit(path.length / 5) + 0.35 * retention + 0.25 * (1 - clampUnit(span / C.ringWindowMs)));
              out.push({
                kind: "LAYERING_RING", accounts: [...path], rows, score, totalAmount: amts.reduce((x, y) => x + y, 0),
                startTs: ts[rows[0]], endTs: t,
                detail: `${path.length}-account cycle closed in ${(span / 3600000).toFixed(1)}h; weakest hop retains ${(retention * 100).toFixed(0)}% of the strongest`,
              });
            }
          }
          taken++;
          continue;
        }
        if (to < s || path.length >= C.ringMaxLen || path.includes(to) || !eligible(to)) continue;
        taken++;
        path.push(to); rowsP.push(r);
        dfs(to, t, isFinite(firstTs) ? firstTs : t, amount[r]);
        path.pop(); rowsP.pop();
      }
    };
    dfs(s, -Infinity, -Infinity, Infinity);
  }
  return truncated;
}

/** Run every detector once. Deterministic: same dataset -> identical report. */
export function detectPatterns(ds: Dataset, an: Analytics): PatternReport {
  const t0 = performance.now();
  const hits: PatternHit[] = [];
  const mask = new Uint8Array(an.nAcc);
  const counts: Record<PatternKind, number> = { LAYERING_RING: 0, FAN_IN: 0, FAN_OUT: 0, QUICK_IN_QUICK_OUT: 0 };
  for (let a = 0; a < an.nAcc; a++) {
    const fi = detectFan(ds, an, a, "in"); if (fi) { hits.push(fi); mask[a] |= PAT_FAN_IN; }
    const fo = detectFan(ds, an, a, "out"); if (fo) { hits.push(fo); mask[a] |= PAT_FAN_OUT; }
    const q = detectQiqo(ds, an, a); if (q) { hits.push(q); mask[a] |= PAT_QIQO; }
  }
  const rings: PatternHit[] = [];
  const truncated = detectRings(ds, an, rings);
  for (const r of rings) for (const a of r.accounts) mask[a] |= PAT_RING;
  hits.push(...rings);
  for (const h of hits) counts[h.kind]++;
  hits.sort((x, y) => y.score - x.score || x.accounts[0] - y.accounts[0]);
  return { hits, mask, counts, truncated, ms: performance.now() - t0 };
}

const patternCache = new WeakMap<Analytics, PatternReport>();
/** Memoised per Analytics object (a re-ingest creates a new Analytics, so the cache invalidates itself). */
export function getPatterns(ds: Dataset, an: Analytics): PatternReport {
  let r = patternCache.get(an);
  if (!r) { r = detectPatterns(ds, an); patternCache.set(an, r); }
  return r;
}
