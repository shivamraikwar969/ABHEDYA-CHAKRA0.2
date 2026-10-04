import {
  FLAG_LABELS, LAYER_LABELS, PATTERN_LABELS, XF_CRYPTO, XF_FOREIGN_IP, XF_HEADLESS, XF_WALLET, FLAG_RAPID_PASSTHROUGH,
  type Dataset, type PatternKind, type TrailResult,
} from "./types";
import { getPatterns } from "./graph";
import { getMuleScores, HIGH_RISK, MULE_FLAG_THRESHOLD } from "./analytics";
import { inr, tsText, verifyText, type CaseFacts } from "./forensics";
import type { Analytics } from "./types";
import { CHANNELS, CHANNEL_ORDER, type ExitSummary } from "./exits";
import { authHeaders } from "./auth";
import { cleanText } from "@/utils/sanitize";

/**
 * Client side of the LOCAL LLM engine (server/llm-server.mjs).
 * The model itself never runs in the browser and never leaves this machine.
 * The browser (1) builds a "fact pack" from the transaction graph, (2) sends it to the local
 * service, and (3) RE-VERIFIES whatever comes back before showing it - so even a compromised
 * or buggy server cannot slip an unverified account number or rupee amount onto a case document.
 */

/** Where the local service listens. Override with VITE_LLM_URL when building. */
export const LLM_BASE: string = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_LLM_URL ?? "http://127.0.0.1:8787";

export interface LlmHealth {
  online: boolean; // the RakshakAI service answered
  reachable: boolean; // ...and it can reach Ollama / llama.cpp
  backend?: string;
  model?: string;
  modelPresent?: boolean;
  reason?: string;
}

export async function llmHealth(): Promise<LlmHealth> {
  try {
    const r = await fetch(`${LLM_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { online: true, reachable: !!j.reachable, backend: j.backend, model: j.model, modelPresent: j.modelPresent, reason: j.reason };
  } catch {
    return { online: false, reachable: false, reason: "Local LLM service not running (start it with: npm run llm)" };
  }
}

export interface FactPack { pack: unknown; allowedIds: string[]; allowedAmounts: number[]; }

/** Everything the model may talk about - pre-formatted so it can copy values verbatim. */
export function buildFactPack(f: CaseFacts, ds: Dataset, tr: TrailResult, ex: ExitSummary | null, tl?: EvidenceTimeline | null): FactPack {
  const exitLines = ex
    ? CHANNEL_ORDER.filter((c) => ex.totals[c]).map((c) => ({ channel: CHANNELS[c].label, amount: inr(ex.totals[c]!.amount), transfers: ex.totals[c]!.count }))
    : [];
  const leaves = ex
    ? ex.leaves.slice(0, 12).map((l) => ({
        account: ds.accounts[l.acc],
        received: inr(l.total),
        exits: CHANNEL_ORDER.filter((c) => l.byChannel[c]).map((c) => `${CHANNELS[c].label}: ${inr(l.byChannel[c]!.amount)}`),
      }))
    : [];
  const pack = {
    victim: { account: f.victimAccount, bank: f.victimBank, ifsc: f.victimIfsc || "not available in the trace" },
    totalSiphoned: inr(f.totalSiphoned),
    firstTransfer: tsText(f.firstTs),
    lastTransfer: tsText(f.lastTs),
    firstHopTransfers: f.hop1Count,
    accountsReached: f.accounts.length,
    cycleBackTransfers: tr.cyclesDetected,
    layerTotals: { layer1: inr(f.layerTotals[0]), layer2: inr(f.layerTotals[1]), layer3: inr(f.layerTotals[2]) },
    accounts: f.accounts.slice(0, 25).map((c) => ({ account: c.account, bank: c.bank, ifsc: c.ifsc || "n/a", layer: c.layer, received: inr(c.received), sent: inr(c.sent), holding: inr(c.net) })),
    freezeRecommended: f.freeze.slice(0, 15).map((c) => ({ account: c.account, bank: c.bank, ifsc: c.ifsc || "n/a", holding: inr(c.net) })),
    exitChannels: exitLines,
    leafAccounts: leaves,
    // chronological evidence (already formatted from graph values; the model may only restate it)
    evidenceTimeline: tl ? tl.events.slice(0, 30).map((e) => ({ seq: e.seq, time: e.timeText, txnId: e.txnId, from: e.from, to: e.to, amount: e.amountText, hop: e.hop, tier: e.tier, confidence: e.confidence, flags: e.flags })) : [],
    entityRiskFlags: tl ? tl.entities.slice(0, 12).map((x) => ({ account: x.account, flags: x.flags })) : [],
  };
  return { pack, allowedIds: [...f.allowed.ids], allowedAmounts: [...f.allowed.amounts] };
}

export interface NarrateOk { ok: true; text: string; backend: string; model: string; attempts: number; checked: number; removedSentences: number; }
export interface NarrateFail { ok: false; fallback: true; reason: string; }

export async function narrateLocal(fp: FactPack, officerNote: string): Promise<(NarrateOk & { clientChecked: number }) | NarrateFail> {
  let j: NarrateOk | NarrateFail;
  try {
    const r = await fetch(`${LLM_BASE}/api/narrate`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, credentials: "omit",
      body: JSON.stringify({ ...fp, officerNote }),
    });
    j = await r.json();
  } catch {
    return { ok: false, fallback: true, reason: "Local LLM service not reachable - showing the deterministic case diary only." };
  }
  if (!j.ok) return j;
  // XSS: model output is untrusted - reduce it to inert text BEFORE the browser re-verification and before it can be shown
  j = { ...j, text: cleanText(j.text, 20_000) };
  // second, independent verification in the browser (fail closed)
  const allowed = { ids: new Set(fp.allowedIds), amounts: new Set(fp.allowedAmounts.map((n) => Math.round(n * 100) / 100)) };
  const v = verifyText(j.text, allowed);
  if (!v.ok) return { ok: false, fallback: true, reason: `Browser re-check blocked the model text (unverified: ${v.violations.slice(0, 4).join(", ")}).` };
  return { ...j, clientChecked: v.checked };
}

// =====================================================================================
//  CHRONOLOGICAL EVIDENCE SYNTHESIZER
//  Deterministic: turns the traced transactions into a time-ordered evidence timeline with
//  auto-extracted entity risk flags and an explicit, auditable evidentiary-confidence weight per entry.
//  Nothing here is model-generated, so every figure is graph-grounded (and passes the same guardrail).
// =====================================================================================

/** Documented, additive weights - changing a number here changes every confidence figure identically. */
export const EVIDENCE_WEIGHTS = {
  base: 0.5, // the transfer exists as a record in the source ledger
  validTimestamp: 0.1,
  hasTxnId: 0.05,
  directFromVictim: 0.15, // hop 1: a direct debit of the victim, no inference needed
  chronologicalContinuity: 0.1, // hop >= 2: the sender demonstrably received funds earlier in the trace
  perHopInferencePenalty: 0.1, // each hop beyond the first adds commingling uncertainty (max 3 hops counted)
  missingTimestampPenalty: 0.25,
  corroboration: 0.05, // per independent corroborating signal, max 3
  maxCorroboration: 3,
} as const;
export const TIER_STRONG = 0.8;
export const TIER_CORROBORATED = 0.6;
export type EvidenceTier = "STRONG" | "CORROBORATED" | "LEAD ONLY";

export interface TimelineEvent {
  seq: number; row: number; ts: number; timeText: string; txnId: string; from: string; to: string;
  amount: number; amountText: string; hop: number; flags: string[]; confidence: number; tier: EvidenceTier; basis: string[];
}
export interface EntityRiskProfile { acc: number; account: string; layer: string; risk: number; mule: number; patterns: PatternKind[]; flags: string[]; }
export interface EvidenceTimeline {
  events: TimelineEvent[]; entities: EntityRiskProfile[];
  tierCounts: Record<EvidenceTier, number>; meanConfidence: number; patternsTruncated: boolean;
}

const tierOf = (c: number): EvidenceTier => (c >= TIER_STRONG ? "STRONG" : c >= TIER_CORROBORATED ? "CORROBORATED" : "LEAD ONLY");
const round2 = (x: number) => Math.round(x * 100) / 100;

export function buildEvidenceTimeline(ds: Dataset, an: Analytics, tr: TrailResult): EvidenceTimeline {
  const W = EVIDENCE_WEIGHTS;
  const pr = getPatterns(ds, an);
  const mule = getMuleScores(ds, an, pr);
  // rows of this trail that sit inside a detected pattern, and what kind
  const trailRows = new Set(tr.edges.map((e) => e.row));
  const rowKinds = new Map<number, Set<PatternKind>>();
  for (const h of pr.hits) for (const r of h.rows) if (trailRows.has(r)) { let k = rowKinds.get(r); if (!k) rowKinds.set(r, (k = new Set())); k.add(h.kind); }
  // earliest traced inflow per account (for chronological continuity)
  const firstIn = new Map<number, number>();
  for (const e of tr.edges) { const cur = firstIn.get(e.receiver); if (!isNaN(e.ts) && (cur === undefined || e.ts < cur)) firstIn.set(e.receiver, e.ts); }

  const ordered = [...tr.edges].sort((a, b) => (isNaN(a.ts) ? 1 : 0) - (isNaN(b.ts) ? 1 : 0) || a.ts - b.ts || a.hop - b.hop || a.row - b.row);
  const events: TimelineEvent[] = ordered.map((e, i) => {
    const flags: string[] = [];
    const basis: string[] = [`ledger record (+${W.base})`];
    let c: number = W.base;
    const f = an.txnFlags[e.row];
    for (const bit of [1, 2, 4, 8, 16]) if (f & bit) flags.push(FLAG_LABELS[bit]);
    const x = ds.xflag[e.row];
    if (x & XF_FOREIGN_IP) flags.push("FOREIGN IP");
    if (x & XF_HEADLESS) flags.push("HEADLESS CLIENT");
    if (x & XF_CRYPTO) flags.push("CRYPTO NARRATION");
    if (x & XF_WALLET) flags.push("WALLET NARRATION");
    if (e.cycle) flags.push("CYCLE-BACK");
    const kinds = rowKinds.get(e.row);
    if (kinds) for (const k of kinds) flags.push(PATTERN_LABELS[k].toUpperCase());
    if (isNaN(e.ts)) { c -= W.missingTimestampPenalty; basis.push(`no timestamp (-${W.missingTimestampPenalty})`); }
    else { c += W.validTimestamp; basis.push(`valid timestamp (+${W.validTimestamp})`); }
    if (e.txnId) { c += W.hasTxnId; basis.push(`transaction id present (+${W.hasTxnId})`); }
    if (e.hop === 1) { c += W.directFromVictim; basis.push(`direct debit of victim (+${W.directFromVictim})`); }
    else {
      const pen = W.perHopInferencePenalty * Math.min(3, e.hop - 1);
      c -= pen; basis.push(`${e.hop - 1} hop(s) of commingling inference (-${round2(pen)})`);
      const fi = firstIn.get(e.sender);
      if (!isNaN(e.ts) && fi !== undefined && fi <= e.ts) { c += W.chronologicalContinuity; basis.push(`sender received funds earlier in trace (+${W.chronologicalContinuity})`); }
    }
    let corr = 0;
    if (kinds) corr += kinds.size;
    if (f & FLAG_RAPID_PASSTHROUGH) corr++;
    if (x) corr++;
    corr = Math.min(W.maxCorroboration, corr);
    if (corr) { c += corr * W.corroboration; basis.push(`${corr} corroborating signal(s) (+${round2(corr * W.corroboration)})`); }
    c = round2(Math.min(0.99, Math.max(0.05, c)));
    const ok = e.amount >= 0;
    return {
      seq: i + 1, row: e.row, ts: e.ts, timeText: tsText(e.ts), txnId: e.txnId, from: ds.accounts[e.sender], to: ds.accounts[e.receiver],
      amount: e.amount, amountText: ok ? inr(e.amount) : "amount n/a", hop: e.hop, flags, confidence: c, tier: tierOf(c), basis,
    };
  });

  // entity risk flags, auto-extracted per account
  const accs = new Set<number>();
  tr.edges.forEach((e) => { accs.add(e.sender); accs.add(e.receiver); });
  const entities: EntityRiskProfile[] = [...accs].map((a) => {
    const flags: string[] = [];
    if (an.risk[a] >= HIGH_RISK) flags.push(`HIGH RISK INDEX ${an.risk[a]}`);
    if (mule.score[a] >= MULE_FLAG_THRESHOLD) flags.push(`MULE SCORE ${mule.score[a]}/100`);
    const m = pr.mask[a];
    const kinds: PatternKind[] = [];
    if (m & 1) kinds.push("LAYERING_RING");
    if (m & 2) kinds.push("FAN_IN");
    if (m & 4) kinds.push("FAN_OUT");
    if (m & 8) kinds.push("QUICK_IN_QUICK_OUT");
    kinds.forEach((k) => flags.push(PATTERN_LABELS[k].toUpperCase()));
    if (an.xFrac[a] >= 0.5) flags.push("CASH-OUT TERMINAL (foreign IP / headless / crypto / wallet)");
    if (!ds.accIfsc[a]) flags.push("IFSC NOT IN DATASET");
    return { acc: a, account: ds.accounts[a], layer: LAYER_LABELS[an.layer[a]], risk: an.risk[a], mule: mule.score[a], patterns: kinds, flags };
  }).filter((x) => x.flags.length).sort((x, y) => y.mule - x.mule || y.risk - x.risk || x.acc - y.acc);

  const tierCounts: Record<EvidenceTier, number> = { STRONG: 0, CORROBORATED: 0, "LEAD ONLY": 0 };
  events.forEach((e) => tierCounts[e.tier]++);
  const meanConfidence = events.length ? round2(events.reduce((s, e) => s + e.confidence, 0) / events.length) : 0;
  return { events, entities, tierCounts, meanConfidence, patternsTruncated: pr.truncated };
}

/** Plain-text rendering for the case diary / print. "## " lines are headings. Only graph-sourced values are printed. */
export function timelineLines(tl: EvidenceTimeline, maxEvents = 150): string[] {
  const L: string[] = [];
  L.push("## 3B. CHRONOLOGICAL EVIDENCE TIMELINE (with evidentiary confidence)");
  L.push(`${tl.events.length} traced transfer(s) in time order. Confidence: mean ${tl.meanConfidence.toFixed(2)} | STRONG (>=0.80) ${tl.tierCounts.STRONG} | CORROBORATED (0.60-0.79) ${tl.tierCounts.CORROBORATED} | LEAD ONLY (<0.60) ${tl.tierCounts["LEAD ONLY"]}.`);
  L.push("Weights are an investigative aid derived from record completeness, hop distance and corroborating signals; they are not a ruling on admissibility. Attach the electronic-record certificate for the source ledger before filing.");
  tl.events.slice(0, maxEvents).forEach((e) =>
    L.push(`T${String(e.seq).padStart(3, "0")} | ${e.timeText} | ${e.txnId} | ${e.from} → ${e.to} | ${e.amountText} | hop ${e.hop} | confidence ${e.confidence.toFixed(2)} ${e.tier}${e.flags.length ? " | " + e.flags.join(", ") : ""}`));
  if (tl.events.length > maxEvents) L.push(`… ${tl.events.length - maxEvents} further entries available in the dossier export.`);
  if (tl.patternsTruncated) L.push("Note: ring search hit its work budget; ring findings are a lower bound.");
  L.push("## 3C. ENTITY RISK FLAGS (auto-extracted)");
  if (!tl.entities.length) L.push("No account in the trace carries a risk flag.");
  tl.entities.slice(0, 40).forEach((x, i) => L.push(`${i + 1}. ${x.account} | ${x.layer} | risk ${x.risk} | mule ${x.mule} | ${x.flags.join(", ")}`));
  return L;
}
