import { type Analytics, type Dataset, XF_CRYPTO, XF_FOREIGN_IP, XF_HEADLESS, XF_WALLET } from "./types";

/**
 * EXIT-CHANNEL ENGINE  ("where did the money finally go?")
 * ---------------------------------------------------------
 * A money trail ends at "leaf" accounts - accounts that pass nothing further inside the
 * view that is currently on screen. For an investigator (or a beginner) the most useful
 * question about a leaf is: HOW did the value leave the banking chain?
 *   - turned into crypto (P2P / USDT exchange)
 *   - withdrawn as cash at an ATM
 *   - loaded into a prepaid wallet / payment gateway
 *   - spent on a card / gift-card
 *   - or it is simply still sitting in the account (parked) / was forwarded onward.
 *
 * Everything here is read straight from the dataset (payment mode + the narration / IP /
 * device flags captured at ingest) - nothing is guessed or generated.
 */

export type ChannelId = "CRYPTO" | "ATM" | "WALLET" | "GIFT" | "CARD" | "ONWARD" | "PARKED" | "OTHER";

export interface ChannelMeta {
  label: string; // short name shown on badges
  plain: string; // beginner-friendly explanation
  color: string; // hex colour used on graph tags / bars
  short: string; // 3-6 letter tag drawn next to a graph node
}

export const CHANNELS: Record<ChannelId, ChannelMeta> = {
  CRYPTO: { label: "Crypto / P2P exchange", plain: "Money was converted into cryptocurrency (e.g. USDT) - very hard to reverse or trace after this point.", color: "#a78bfa", short: "CRYPTO" },
  ATM: { label: "ATM / cash withdrawal", plain: "Money was taken out as physical cash at an ATM or counter - recover via CCTV and ATM location records.", color: "#f59e0b", short: "ATM" },
  WALLET: { label: "Wallet / payment gateway", plain: "Money was loaded into a prepaid wallet or payment gateway - ask the wallet company to freeze it.", color: "#22d3ee", short: "WALLET" },
  GIFT: { label: "Gift card / voucher", plain: "Money was converted into gift cards or vouchers.", color: "#f472b6", short: "GIFT" },
  CARD: { label: "Card / POS spend", plain: "Money was spent through a debit / credit card or POS machine.", color: "#34d399", short: "CARD" },
  ONWARD: { label: "Forwarded onward (outside this view)", plain: "The account sent the money on to other accounts within 24 hours; the chain continues beyond what is drawn here.", color: "#f97316", short: "ONWARD" },
  PARKED: { label: "Still sitting in the account", plain: "No outgoing transfer was seen - the money may still be in this account, so it is the best candidate for an immediate freeze.", color: "#ef4444", short: "PARKED" },
  OTHER: { label: "Other / unclassified", plain: "The payment mode is missing or not recognised.", color: "#94a3b8", short: "OTHER" },
};

/** Display order: the exits that are hardest to reverse come first. */
export const CHANNEL_ORDER: ChannelId[] = ["CRYPTO", "ATM", "WALLET", "GIFT", "CARD", "ONWARD", "PARKED", "OTHER"];

/** Channels that mean the value has genuinely left the bank-to-bank chain. */
const TERMINAL = new Set<ChannelId>(["CRYPTO", "ATM", "WALLET", "GIFT", "CARD"]);

/** Classify ONE transaction row by how the value moved (priority: crypto > ATM > wallet > gift > card). */
export function channelOfRow(ds: Dataset, r: number): ChannelId {
  const x = ds.xflag[r];
  const m = ds.modes[ds.mode[r]] ?? "";
  if (x & XF_CRYPTO || /CRYPTO|USDT|BINANCE|BTC/i.test(m)) return "CRYPTO";
  if (/ATM|CASH|WITHDRAW/i.test(m)) return "ATM";
  if (x & XF_WALLET || /WALLET|PREPAID/i.test(m)) return "WALLET";
  if (/GIFT|VOUCHER/i.test(m)) return "GIFT";
  if (/CARD|POS/i.test(m)) return "CARD";
  if (/UPI|IMPS|NEFT|RTGS/i.test(m)) return "OTHER"; // plain bank transfer: decided by the caller (parked / onward)
  return "OTHER";
}

export interface ChannelAmt { amount: number; count: number; }
export type ChannelMap = Partial<Record<ChannelId, ChannelAmt>>;

export interface LeafExit {
  acc: number;
  total: number; // value that arrived at this leaf through the visible edges
  byChannel: ChannelMap; // how that value left the chain
  beyond: ChannelMap; // channels of onward transfers that happened outside the view (<= 24h after receipt)
  foreignIp: number; // arriving txns carrying a foreign-IP signal
  headless: number; // arriving txns from an emulator / script device
  firstTs: number;
  lastTs: number;
}

export interface ExitSummary {
  leaves: LeafExit[]; // sorted by value, largest first
  totals: ChannelMap; // sum over all leaves
  beyondTotals: ChannelMap;
  grand: number; // total value that reached a leaf / exit
}

const DAY = 24 * 3600 * 1000;

const add = (m: ChannelMap, ch: ChannelId, amt: number) => {
  const c = m[ch] ?? (m[ch] = { amount: 0, count: 0 });
  c.amount += amt;
  c.count++;
};

/**
 * Work out where the money went for the transactions currently shown.
 * @param rows  dataset row indices of the edges on screen (trail edges or isolated ring edges)
 * @param cur   playback cursor (epoch ms) - only transactions at/before it count; null = everything
 * @param an    analytics (optional) - lets us tell "forwarded onward" from "parked"
 */
export function computeExits(ds: Dataset, an: Analytics | null, rows: number[], cur: number | null = null): ExitSummary {
  // 1. keep only what has "happened" at the playback cursor
  const vis: number[] = [];
  for (const r of rows) {
    const t = ds.ts[r];
    if (cur === null || isNaN(t) || t <= cur) vis.push(r);
  }
  const visSet = new Set(vis);
  const hasOut = new Set<number>(); // accounts that pass money on inside the view
  for (const r of vis) hasOut.add(ds.sender[r]);

  const leaves = new Map<number, LeafExit>();
  const totals: ChannelMap = {};
  const beyondTotals: ChannelMap = {};
  let grand = 0;

  for (const r of vis) {
    const to = ds.receiver[r];
    if (ds.sender[r] === to) continue; // self transfer
    let ch = channelOfRow(ds, r);
    const terminal = TERMINAL.has(ch);
    // a plain bank transfer into an account that keeps passing money on is just a relay, not an exit
    if (!terminal && hasOut.has(to)) continue;
    const amt = ds.amount[r] >= 0 ? ds.amount[r] : 0;
    let leaf = leaves.get(to);
    if (!leaf) {
      leaf = { acc: to, total: 0, byChannel: {}, beyond: {}, foreignIp: 0, headless: 0, firstTs: NaN, lastTs: NaN };
      leaves.set(to, leaf);
    }

    if (!terminal) {
      // landed in a bank account that shows no further move inside the view
      ch = "PARKED";
      if (an) {
        const t0 = ds.ts[r];
        let seen = 0;
        for (let k = an.outStart[to]; k < an.outStart[to + 1] && seen < 50; k++) {
          const o = an.outIdx[k];
          if (visSet.has(o) || ds.sender[o] === ds.receiver[o]) continue;
          const t1 = ds.ts[o];
          if (!isNaN(t0) && !isNaN(t1) && (t1 < t0 || t1 - t0 > DAY)) continue; // only money moved onward within 24h
          if (cur !== null && !isNaN(t1) && t1 > cur) continue; // hasn't happened yet at the cursor
          ch = "ONWARD";
          seen++;
          let bch = channelOfRow(ds, o);
          if (!TERMINAL.has(bch)) bch = "OTHER";
          const ba = ds.amount[o] >= 0 ? ds.amount[o] : 0;
          add(leaf.beyond, bch, ba);
          add(beyondTotals, bch, ba);
        }
      }
    }

    add(leaf.byChannel, ch, amt);
    add(totals, ch, amt);
    leaf.total += amt;
    grand += amt;
    const x = ds.xflag[r];
    if (x & XF_FOREIGN_IP) leaf.foreignIp++;
    if (x & XF_HEADLESS) leaf.headless++;
    const t = ds.ts[r];
    if (!isNaN(t)) {
      if (isNaN(leaf.firstTs) || t < leaf.firstTs) leaf.firstTs = t;
      if (isNaN(leaf.lastTs) || t > leaf.lastTs) leaf.lastTs = t;
    }
  }
  return { leaves: [...leaves.values()].sort((a, b) => b.total - a.total), totals, beyondTotals, grand };
}

/** Compact rupee text for graph tags (12.4K, 1.2L, 3.4Cr). */
export function abbrINR(n: number): string {
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(1) + "Cr";
  if (n >= 1e5) return "₹" + (n / 1e5).toFixed(1) + "L";
  if (n >= 1e3) return "₹" + (n / 1e3).toFixed(1) + "K";
  return "₹" + Math.round(n);
}

export interface LeafTag { text: string; color: string; }

/** Small coloured tags drawn under each leaf node on the graph, e.g. "CRYPTO ₹49.0K". */
export function leafTags(ex: ExitSummary): Map<number, LeafTag[]> {
  const out = new Map<number, LeafTag[]>();
  for (const l of ex.leaves) {
    const tags = CHANNEL_ORDER.filter((c) => l.byChannel[c]).sort((a, b) => l.byChannel[b]!.amount - l.byChannel[a]!.amount).slice(0, 3)
      .map((c) => ({ text: `${CHANNELS[c].short} ${abbrINR(l.byChannel[c]!.amount)}`, color: CHANNELS[c].color }));
    if (tags.length) out.set(l.acc, tags);
  }
  return out;
}
