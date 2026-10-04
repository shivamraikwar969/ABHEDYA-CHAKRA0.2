import type { Analytics, Dataset, TrailEdge, TrailResult } from "./types";
import { csvCell } from "@/utils/sanitize";
import { lowerBoundTs } from "./analytics";

export interface TrailOptions {
  maxHops: number; // hard-capped at 4
  branchCap: number; // max outgoing edges expanded per node per hop
  edgeCap: number; // global ledger cap
  chronological: boolean; // only follow outflows at/after inbound timestamp
  minAmount: number;
  startAfter?: number; // epoch ms; only consider victim outflows after this
}

export const DEFAULT_TRAIL_OPTIONS: TrailOptions = {
  maxHops: 4,
  branchCap: 25,
  edgeCap: 2500,
  chronological: true,
  minAmount: 0,
};

interface Frontier { acc: number; minTs: number; }

/**
 * Bounded breadth-first traversal of outbound funds from a victim account.
 * - Strictly capped at 4 hops.
 * - Cycle detection: an account is expanded at most once; edges returning to an already
 *   visited account are recorded as `cycle` edges but never expanded.
 * - Multi-branch: every eligible outflow (up to branchCap, largest amounts first) is followed.
 */
export function traceTrail(ds: Dataset, an: Analytics, victim: number, opts: TrailOptions): TrailResult {
  const t0 = performance.now();
  const maxHops = Math.min(4, Math.max(1, opts.maxHops));
  const visited = new Set<number>([victim]);
  const edges: TrailEdge[] = [];
  const hopCounts = [0, 0, 0, 0, 0];
  let cycles = 0, truncated = false, totalAmount = 0;
  let frontier: Frontier[] = [{ acc: victim, minTs: opts.startAfter ?? -Infinity }];
  const { ts, amount, receiver, sender, txnIds } = ds;

  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next: Frontier[] = [];
    const nextSeen = new Map<number, number>(); // acc -> index in next (keep earliest minTs)
    for (const f of frontier) {
      const os = an.outStart[f.acc], oe = an.outStart[f.acc + 1];
      const eligible: number[] = [];
      // outflows are time-ordered in the CSR: jump straight to the first one at/after the inbound time (O(log d), not O(d))
      const from = opts.chronological && isFinite(f.minTs) ? lowerBoundTs(ts, an.outIdx, os, oe, f.minTs) : os;
      let nanEnd = os; // unparsable-time rows sort first and stay eligible (same behaviour as the linear scan)
      while (nanEnd < oe && isNaN(ts[an.outIdx[nanEnd]])) nanEnd++;
      for (let k = os; k < oe; k++) {
        if (k >= nanEnd && k < from) k = from;
        if (k >= oe) break;
        const r = an.outIdx[k];
        const t = ts[r];
        if (opts.chronological && !isNaN(t) && isFinite(f.minTs) && t < f.minTs) continue;
        if (!(amount[r] >= opts.minAmount)) continue;
        if (receiver[r] === f.acc) continue; // self transfer, ignore
        eligible.push(r);
      }
      if (eligible.length > opts.branchCap) {
        eligible.sort((x, y) => amount[y] - amount[x]);
        eligible.length = opts.branchCap;
        truncated = true;
      }
      for (const r of eligible) {
        if (edges.length >= opts.edgeCap) { truncated = true; break; }
        const to = receiver[r];
        const isCycle = visited.has(to);
        if (isCycle) cycles++;
        edges.push({
          hop, row: r, sender: sender[r], receiver: to, amount: amount[r], ts: ts[r], txnId: txnIds[r],
          layer: an.layer[to], risk: an.risk[to], cycle: isCycle,
        });
        hopCounts[hop]++;
        if (amount[r] >= 0) totalAmount += amount[r];
        if (!isCycle) {
          visited.add(to);
          const nt = isNaN(ts[r]) ? f.minTs : ts[r];
          const existing = nextSeen.get(to);
          if (existing === undefined) { nextSeen.set(to, next.length); next.push({ acc: to, minTs: nt }); }
          else if (nt < next[existing].minTs) next[existing].minTs = nt;
        }
      }
    }
    frontier = next;
  }
  edges.sort((a, b) => a.hop - b.hop || (a.ts || 0) - (b.ts || 0));
  return {
    victim, edges, hopCounts, accountsVisited: visited.size, cyclesDetected: cycles, truncated, totalAmount,
    ms: performance.now() - t0,
  };
}

export function trailToCSV(ds: Dataset, res: TrailResult, layerLabels: string[]): string {
  const lines = ["hop,sender,receiver,amount,timestamp,txn_id,layer,risk_index,cycle"];
  for (const e of res.edges) {
    lines.push([
      e.hop, ds.accounts[e.sender], ds.accounts[e.receiver], e.amount, isNaN(e.ts) ? "" : new Date(e.ts).toISOString(), e.txnId,
      layerLabels[e.layer], e.risk, e.cycle ? "YES" : "",
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}
