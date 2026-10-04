import { type Analytics, type Dataset, type TrailResult, XF_ANY, XF_CRYPTO, XF_FOREIGN_IP, XF_HEADLESS, XF_WALLET } from "./types";
import type { GEdge, GNode } from "@/components/ForceGraph";
import { MED_RISK } from "./analytics";
import { originalRecord } from "./dataset";
import { cleanText } from "@/utils/sanitize";
import { CHANNELS, CHANNEL_ORDER, computeExits, type ExitSummary } from "./exits";

// ---------------- Module A: entity normalization & instant account search ----------------
export const BANKS: Record<string, string> = {
  SBIN: "State Bank of India", HDFC: "HDFC Bank", ICIC: "ICICI Bank", UTIB: "Axis Bank", PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda", CNRB: "Canara Bank", KKBK: "Kotak Mahindra Bank", IDIB: "Indian Bank", YESB: "YES Bank",
  UBIN: "Union Bank of India", BKID: "Bank of India", IDFB: "IDFC FIRST Bank", INDB: "IndusInd Bank",
};
export const bankOf = (ifsc: string) => {
  const p = (ifsc || "").slice(0, 4).toUpperCase();
  return p ? BANKS[p] ?? `Unmapped bank (${p})` : "Bank not identified (no IFSC in dataset)";
};

export interface Counterparty { acc: number; inAmt: number; outAmt: number; count: number; }
export interface AccountHistory {
  rows: number[]; // chronological
  cps: Counterparty[];
  modes: { mode: string; count: number }[];
  signals: { foreign: number; headless: number; crypto: number; wallet: number };
  ms: number;
}

export function accountHistory(ds: Dataset, an: Analytics, a: number): AccountHistory {
  const t0 = performance.now();
  const rows = [...an.inIdx.subarray(an.inStart[a], an.inStart[a + 1]), ...an.outIdx.subarray(an.outStart[a], an.outStart[a + 1])];
  rows.sort((x, y) => (ds.ts[x] || 0) - (ds.ts[y] || 0) || x - y);
  const cp = new Map<number, Counterparty>();
  const md = new Map<string, number>();
  const signals = { foreign: 0, headless: 0, crypto: 0, wallet: 0 };
  for (const r of rows) {
    const out = ds.sender[r] === a;
    const o = out ? ds.receiver[r] : ds.sender[r];
    let c = cp.get(o);
    if (!c) { c = { acc: o, inAmt: 0, outAmt: 0, count: 0 }; cp.set(o, c); }
    c.count++;
    const am = ds.amount[r] >= 0 ? ds.amount[r] : 0;
    if (out) c.outAmt += am; else c.inAmt += am;
    const m = ds.modes[ds.mode[r]];
    md.set(m, (md.get(m) ?? 0) + 1);
    const x = ds.xflag[r];
    if (x & XF_FOREIGN_IP) signals.foreign++;
    if (x & XF_HEADLESS) signals.headless++;
    if (x & XF_CRYPTO) signals.crypto++;
    if (x & XF_WALLET) signals.wallet++;
  }
  return {
    rows,
    cps: [...cp.values()].sort((x, y) => y.inAmt + y.outAmt - (x.inAmt + x.outAmt)),
    modes: [...md.entries()].map(([mode, count]) => ({ mode, count })).sort((x, y) => y.count - x.count),
    signals,
    ms: performance.now() - t0,
  };
}

// ---------------- Module C: ring isolation, sub-dataset export, graph building ----------------
export function isolateRing(ds: Dataset, an: Analytics, seed: number, maxNodes = 400): { nodes: Set<number>; rows: number[] } {
  const set = new Set<number>([seed]);
  const q = [seed];
  const suspicious = (o: number) => an.risk[o] >= MED_RISK || an.layer[o] !== 0 || an.xFrac[o] >= 0.5;
  for (let i = 0; i < q.length && set.size < maxNodes; i++) {
    const c = q[i];
    for (const dir of [0, 1]) {
      const st = dir === 0 ? an.outStart : an.inStart, ix = dir === 0 ? an.outIdx : an.inIdx;
      for (let k = st[c]; k < st[c + 1] && set.size < maxNodes; k++) {
        const r = ix[k];
        const o = dir === 0 ? ds.receiver[r] : ds.sender[r];
        if (set.has(o) || !suspicious(o)) continue;
        set.add(o); q.push(o);
      }
    }
  }
  if (set.size < 3) { // seed is isolated from other flagged nodes → fall back to its direct neighbourhood
    for (const dir of [0, 1]) {
      const st = dir === 0 ? an.outStart : an.inStart, ix = dir === 0 ? an.outIdx : an.inIdx;
      for (let k = st[seed]; k < st[seed + 1] && set.size < 60; k++) set.add(dir === 0 ? ds.receiver[ix[k]] : ds.sender[ix[k]]);
    }
  }
  const rows: number[] = [];
  for (const a of set) {
    for (let k = an.outStart[a]; k < an.outStart[a + 1] && rows.length < 5000; k++) {
      const r = an.outIdx[k];
      if (set.has(ds.receiver[r]) && ds.receiver[r] !== a) rows.push(r);
    }
  }
  return { nodes: set, rows };
}

/** Sub-dataset export: exact original CSV records of the given rows. */
export function exportRowsCSV(ds: Dataset, rows: number[]): string {
  return [ds.headers.join(","), ...rows.map((r) => originalRecord(ds, r).raw)].join("\n");
}

export function rowsToGraph(ds: Dataset, an: Analytics, rows: number[], hops?: Map<number, number>): { nodes: GNode[]; edges: GEdge[] } {
  const nm = new Map<number, GNode>();
  const mk = (a: number) => { if (!nm.has(a)) nm.set(a, { id: a, label: ds.accounts[a], risk: an.risk[a], degree: an.inCount[a] + an.outCount[a], layer: an.layer[a] }); };
  const edges = rows.map((r) => {
    mk(ds.sender[r]); mk(ds.receiver[r]);
    return { source: ds.sender[r], target: ds.receiver[r], row: r, txnId: ds.txnIds[r], amount: ds.amount[r], ts: ds.ts[r], flagged: an.txnFlags[r] !== 0 || (ds.xflag[r] & XF_ANY) !== 0, hop: hops?.get(r) } as GEdge;
  });
  return { nodes: [...nm.values()], edges };
}

// ---------------- Module D: case facts (single source of truth), diary, notices, guardrail ----------------
export interface CaseAccount {
  acc: number; account: string; ifsc: string; bank: string;
  layer: 1 | 2 | 3; hop: number; received: number; sent: number; net: number; firstTs: number; inbound: number[];
}
export interface Allowed { ids: Set<string>; amounts: Set<number>; }
export interface CaseFacts {
  victim: number; victimAccount: string; victimIfsc: string; victimBank: string;
  totalSiphoned: number; hop1Count: number; firstTs: number; lastTs: number;
  accounts: CaseAccount[]; freeze: CaseAccount[]; layerTotals: [number, number, number];
  allowed: Allowed;
  exits?: ExitSummary; // where the money finally went (crypto / ATM / wallet ...)
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const p2 = (n: number) => String(n).padStart(2, "0");
export const tsText = (t: number) => {
  if (isNaN(t)) return "time n/a";
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

export function buildCase(ds: Dataset, tr: TrailResult, an?: Analytics): CaseFacts {
  const m = new Map<number, CaseAccount>();
  const get = (a: number, hop: number): CaseAccount => {
    let c = m.get(a);
    if (!c) {
      const ifsc = ds.accIfsc[a] || "";
      c = { acc: a, account: ds.accounts[a], ifsc, bank: bankOf(ifsc), layer: (hop >= 3 ? 3 : hop) as 1 | 2 | 3, hop, received: 0, sent: 0, net: 0, firstTs: NaN, inbound: [] };
      m.set(a, c);
    }
    return c;
  };
  let total = 0, hop1 = 0, first = Infinity, last = -Infinity;
  const layerTotals: [number, number, number] = [0, 0, 0];
  for (const e of tr.edges) { // edges are sorted hop-ascending, so first sight = minimum hop
    const amt = e.amount >= 0 ? e.amount : 0;
    if (e.receiver !== tr.victim) {
      const c = get(e.receiver, e.hop);
      c.received += amt; c.inbound.push(e.row);
      if (isNaN(c.firstTs) || e.ts < c.firstTs) c.firstTs = e.ts;
    }
    const s = m.get(e.sender);
    if (s) s.sent += amt;
    if (e.hop === 1) { total += amt; hop1++; }
    if (!e.cycle) layerTotals[Math.min(e.hop, 3) - 1] += amt;
    if (!isNaN(e.ts)) { if (e.ts < first) first = e.ts; if (e.ts > last) last = e.ts; }
  }
  const accounts = [...m.values()].sort((a, b) => a.hop - b.hop || (a.firstTs || 0) - (b.firstTs || 0));
  accounts.forEach((c) => { c.net = r2(c.received - c.sent); });
  const freeze = accounts.filter((c) => c.net > 0.5).sort((a, b) => b.net - a.net);

  const ids = new Set<string>([ds.accounts[tr.victim]]);
  const amounts = new Set<number>([r2(total), ...layerTotals.map(r2)]);
  accounts.forEach((c) => { ids.add(c.account); if (c.ifsc) ids.add(c.ifsc); amounts.add(r2(c.received)); amounts.add(r2(c.sent)); amounts.add(c.net); });
  const vIfsc = ds.accIfsc[tr.victim] || "";
  if (vIfsc) ids.add(vIfsc);
  tr.edges.forEach((e) => { ids.add(e.txnId); if (e.amount >= 0) amounts.add(r2(e.amount)); });
  amounts.add(r2(freeze.reduce((s, c) => s + c.net, 0)));
  // exit channels: every figure we print must also be whitelisted for the guardrail
  const exits = computeExits(ds, an ?? null, tr.edges.map((e) => e.row), null);
  amounts.add(r2(exits.grand));
  for (const ch of CHANNEL_ORDER) {
    if (exits.totals[ch]) amounts.add(r2(exits.totals[ch]!.amount));
    if (exits.beyondTotals[ch]) amounts.add(r2(exits.beyondTotals[ch]!.amount));
  }
  for (const l of exits.leaves) {
    ids.add(ds.accounts[l.acc]);
    amounts.add(r2(l.total));
    for (const ch of CHANNEL_ORDER) if (l.byChannel[ch]) amounts.add(r2(l.byChannel[ch]!.amount));
  }
  return {
    victim: tr.victim, victimAccount: ds.accounts[tr.victim], victimIfsc: vIfsc, victimBank: bankOf(vIfsc),
    totalSiphoned: total, hop1Count: hop1, firstTs: isFinite(first) ? first : NaN, lastTs: isFinite(last) ? last : NaN,
    accounts, freeze, layerTotals, allowed: { ids, amounts }, exits,
  };
}

const LAYER_TITLE = ["", "LAYER 1 · COLLECTOR MULE ACCOUNTS (direct recipients from victim)", "LAYER 2 · DISTRIBUTOR MULE ACCOUNTS", "LAYER 3 · TERMINAL / CASH-OUT ACCOUNTS"];

/** Deterministic, graph-grounded diary. Lines beginning "## " are headings. Every entity is read from the dataset, never generated. */
export function caseDiaryLines(f: CaseFacts, ds: Dataset, tr: TrailResult): string[] {
  const L: string[] = [];
  L.push("## 1. VICTIM ACCOUNT & TOTAL FUNDS SIPHONED");
  L.push(`Victim account ${f.victimAccount} (${f.victimBank}${f.victimIfsc ? ", IFSC " + f.victimIfsc : ""}).`);
  L.push(`Total funds siphoned from the victim account (first-hop debits): ${inr(f.totalSiphoned)} across ${f.hop1Count} transaction(s), between ${tsText(f.firstTs)} and ${tsText(f.lastTs)}.`);
  L.push(`Downstream trace reached ${f.accounts.length} account(s) over up to 4 hops${tr.cyclesDetected ? `; ${tr.cyclesDetected} cycle-back transfer(s) detected` : ""}${tr.truncated ? "; trace bounded by caps (not exhaustive)" : ""}.`);
  L.push("## 2. LAYER-WISE MONEY TRAIL (chronological)");
  for (const lay of [1, 2, 3] as const) {
    const edges = tr.edges.filter((e) => Math.min(e.hop, 3) === lay).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    L.push(`${LAYER_TITLE[lay]} — ${edges.length} transfer(s), ${inr(f.layerTotals[lay - 1])}`);
    edges.slice(0, 80).forEach((e) => L.push(`${tsText(e.ts)} | ${e.txnId} | ${ds.accounts[e.sender]} → ${ds.accounts[e.receiver]} | ${inr(e.amount)}${e.cycle ? " | cycle-back" : ""}`));
    if (edges.length > 80) L.push(`… ${edges.length - 80} further transfer(s) available in the trail CSV export.`);
  }
  L.push("## 3. CURRENT HOLDING ACCOUNTS — RECOMMENDED FOR IMMEDIATE FREEZE");
  if (!f.freeze.length) L.push("No account retains a positive balance within the traced trail.");
  f.freeze.forEach((c, i) => L.push(`${i + 1}. ${c.account} | ${c.bank}${c.ifsc ? " | IFSC " + c.ifsc : ""} | Layer ${c.layer} | traced holding ${inr(c.net)}`));
  if (f.exits && f.exits.leaves.length) {
    L.push("## 3A. WHERE THE MONEY WENT — EXIT CHANNELS (final destination of traced funds)");
    for (const ch of CHANNEL_ORDER) {
      const t = f.exits.totals[ch];
      if (t) L.push(`${CHANNELS[ch].label}: ${inr(t.amount)} across ${t.count} transfer(s).`);
    }
    f.exits.leaves.slice(0, 40).forEach((l, i) => {
      const parts = CHANNEL_ORDER.filter((ch) => l.byChannel[ch]).map((ch) => `${CHANNELS[ch].short} ${inr(l.byChannel[ch]!.amount)}`);
      L.push(`${i + 1}. ${ds.accounts[l.acc]} | received ${inr(l.total)} | ${parts.join("; ")}${l.foreignIp ? ` | foreign-IP signal on ${l.foreignIp} txn(s)` : ""}`);
    });
  }
  return L;
}

export interface NoticeRow { txnId: string; from: string; amount: number; ts: number; }
export interface Notice { bank: string; accounts: { c: CaseAccount; txns: NoticeRow[]; total: number }[]; total: number; }

export function buildNotices(f: CaseFacts, ds: Dataset): Notice[] {
  const by = new Map<string, Notice>();
  for (const c of f.freeze) {
    let n = by.get(c.bank);
    if (!n) { n = { bank: c.bank, accounts: [], total: 0 }; by.set(c.bank, n); }
    const txns = c.inbound.map((r) => ({ txnId: ds.txnIds[r], from: ds.accounts[ds.sender[r]], amount: ds.amount[r], ts: ds.ts[r] })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    n.accounts.push({ c, txns, total: c.net });
    n.total += c.net;
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** Plain-text serialization of every notice row, used for guardrail verification. */
export function noticeLines(ns: Notice[]): string[] {
  return ns.flatMap((n) => n.accounts.flatMap((a) => [
    `${a.c.account} ${a.c.ifsc} ${inr(a.total)}`,
    ...a.txns.map((t) => `${t.txnId} ${t.from} ${inr(t.amount)}`),
  ]));
}

// ---------------- Anti-hallucination / prompt-injection guardrail ----------------
const ID_RE = /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\b/g;
const AMT_RE = /₹\s?([\d,]+(?:\.\d+)?)/g;
const INJECTION_RE = /ignore\s+(all\s+)?(previous|prior|above)\s+instructions|system\s+prompt|you\s+are\s+now|disregard\s+the\s+above/gi;

export function verifyText(text: string, allowed: Allowed): { ok: boolean; checked: number; violations: string[] } {
  const violations: string[] = [];
  let checked = 0;
  for (const m of text.matchAll(AMT_RE)) { checked++; if (!allowed.amounts.has(r2(Number(m[1].replace(/,/g, ""))))) violations.push(m[0]); }
  for (const m of text.matchAll(ID_RE)) { checked++; if (!allowed.ids.has(m[0])) violations.push(m[0]); }
  return { ok: violations.length === 0, checked, violations };
}

/** Officer free-text is untrusted: stripped of markup / injection phrases, and any account-like or amount token not present in the graph is removed. Output is rendered as inert text. */
export function sanitizeRemarks(raw: string, allowed: Allowed): string {
  let t = cleanText(raw, 4000).replace(/[\u0000-\u001f\u007f<>`{}[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
  t = t.replace(INJECTION_RE, "[FILTERED]");
  t = t.replace(AMT_RE, (m, n: string) => (allowed.amounts.has(r2(Number(n.replace(/,/g, "")))) ? m : "[UNVERIFIED-AMOUNT-REMOVED]"));
  t = t.replace(ID_RE, (m) => (allowed.ids.has(m) ? m : "[UNVERIFIED-ID-REMOVED]"));
  return t;
}
