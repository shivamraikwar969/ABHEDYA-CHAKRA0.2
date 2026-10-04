import Papa from "papaparse";
import type { ColumnMapping, Dataset, MappingKey, Profile } from "./types";

export const RAW_RETENTION_CAP = 1_000_000;
const CRYPTO_RE = /crypto|usdt|p2p|binance|bitcoin|btc/i;
const WALLET_RE = /wallet|gateway|paytm|prepaid|topup/i;
const SCAM_RE = /task|arrest|loan|invest|ponzi|bonus|kyc update/i;

const PATTERNS: Record<MappingKey, RegExp[]> = {
  txnId: [/^(txn|transaction|trans|tx)[_ -]?(id|ref|no|number)?$/i, /^(id|ref(erence)?|utr|rrn)$/i, /txn.*id|transaction.*id|trans.*ref/i],
  sender: [/^(sender|from|source|src|payer|debit|originator|remitter)/i, /sender|from_acc|from account|payer|debit|origin|remitter/i],
  receiver: [/^(receiver|to|dest|destination|beneficiary|payee|credit|recipient)/i, /receiver|to_acc|to account|payee|credit|benef|recipient|dest/i],
  amount: [/^(amount|amt|value|txn_amount|transaction_amount)$/i, /amount|amt|value|sum/i],
  timestamp: [/^(timestamp|time|date|datetime|txn_time|txn_date|transaction_date|created_at)$/i, /time|date/i],
  ifscS: [/^(sender|from|src|payer|remitter)[_ -]?ifsc/i, /sender.*ifsc|from.*ifsc/i],
  ifscR: [/^(receiver|to|dest|beneficiary|payee)[_ -]?ifsc/i, /receiver.*ifsc|benef.*ifsc|dest.*ifsc/i],
  narration: [/^(narration|remarks?|description|memo|particulars)$/i, /narrat|remark|descr/i],
  ip: [/^(ip|ip_address|ipaddress|client_ip|source_ip)$/i, /(^|[_ -])ip([_ -]|$)/i],
  device: [/^(device|device_type|user_agent|useragent|ua)$/i, /device|agent/i],
  mode: [/^(mode|payment_mode|channel|type|method|txn_type|payment_type)$/i, /mode|channel|method|type/i],
};

export function detectMapping(headers: string[]): ColumnMapping {
  const used = new Set<number>();
  const m: ColumnMapping = { txnId: -1, sender: -1, receiver: -1, amount: -1, timestamp: -1, mode: -1, ifscS: -1, ifscR: -1, narration: -1, ip: -1, device: -1 };
  const order: MappingKey[] = ["txnId", "ifscS", "ifscR", "device", "ip", "narration", "sender", "receiver", "amount", "timestamp", "mode"];
  for (let pass = 0; pass < 2; pass++) {
    for (const key of order) {
      if (m[key] >= 0) continue;
      const re = PATTERNS[key][pass];
      const idx = headers.findIndex((h, i) => !used.has(i) && re.test(h.trim()));
      if (idx >= 0) {
        m[key] = idx;
        used.add(idx);
      }
    }
  }
  return m;
}

export interface PreviewResult {
  headers: string[];
  rows: string[][];
  mapping: ColumnMapping;
}

export function previewCSV(source: File | string): Promise<PreviewResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(source as File, {
      preview: 8,
      skipEmptyLines: true,
      complete: (res) => {
        const data = res.data.filter((r) => r.length > 1);
        if (!data.length) return reject(new Error("CSV appears to be empty or has no delimited columns."));
        const headers = data[0].map((h) => String(h).trim());
        resolve({ headers, rows: data.slice(1), mapping: detectMapping(headers) });
      },
      error: (err: Error) => reject(err),
    });
  });
}

const tsCache = new Map<string, number>();
function parseTs(s: string): number {
  if (!s) return NaN;
  let v = tsCache.get(s);
  if (v !== undefined) return v;
  const t = s.trim();
  if (/^\d{9,13}$/.test(t)) {
    v = t.length <= 10 ? Number(t) * 1000 : Number(t);
  } else {
    v = Date.parse(t);
    if (isNaN(v)) {
      // dd/mm/yyyy or dd-mm-yyyy [HH:MM[:SS]]
      const mm = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      if (mm) {
        const yr = mm[3].length === 2 ? 2000 + Number(mm[3]) : Number(mm[3]);
        v = new Date(yr, Number(mm[2]) - 1, Number(mm[1]), Number(mm[4] || 0), Number(mm[5] || 0), Number(mm[6] || 0)).getTime();
      }
    }
  }
  if (tsCache.size < 200000) tsCache.set(s, v);
  return v;
}

function parseAmount(s: string): number {
  if (!s) return NaN;
  const n = Number(s.replace(/[₹$,\s]/g, ""));
  return n;
}

export interface IngestProgress {
  rows: number;
  bytes: number;
  totalBytes: number;
  phase: string;
}

export async function ingestCSV(
  source: File | string,
  name: string,
  headers: string[],
  mapping: ColumnMapping,
  onProgress: (p: IngestProgress) => void
): Promise<Dataset> {
  const t0 = performance.now();
  const totalBytes = typeof source === "string" ? source.length : source.size;
  const accounts: string[] = [];
  const accountIndex = new Map<string, number>();
  const txnIds: string[] = [];
  const modes: string[] = [];
  const modeIndex = new Map<string, number>();
  const rawLines: string[] = [];
  let cap = 1 << 16;
  let sender = new Int32Array(cap);
  let receiver = new Int32Array(cap);
  let amount = new Float64Array(cap);
  let ts = new Float64Array(cap);
  let mode = new Uint16Array(cap);
  let xflag = new Uint8Array(cap);
  const accIfsc: string[] = [];
  let n = 0;
  const nCols = headers.length;
  const nullCounts = new Int32Array(nCols);
  // sample matrix (first 240 rows, every k-th)
  const matrixRows = 240;
  const matrix = new Uint8Array(matrixRows * nCols);
  let matrixFilled = 0;

  const accOf = (s: string): number => {
    let i = accountIndex.get(s);
    if (i === undefined) {
      i = accounts.length;
      accounts.push(s);
      accIfsc.push("");
      accountIndex.set(s, i);
    }
    return i;
  };

  const grow = () => {
    cap *= 2;
    const ns = new Int32Array(cap); ns.set(sender); sender = ns;
    const nr = new Int32Array(cap); nr.set(receiver); receiver = nr;
    const na = new Float64Array(cap); na.set(amount); amount = na;
    const nt = new Float64Array(cap); nt.set(ts); ts = nt;
    const nm = new Uint16Array(cap); nm.set(mode); mode = nm;
    const nx = new Uint8Array(cap); nx.set(xflag); xflag = nx;
  };

  let lastReport = 0;
  let headerSkipped = false;

  await new Promise<void>((resolve, reject) => {
    Papa.parse<string[]>(source as File, {
      skipEmptyLines: true,
      chunkSize: 1024 * 1024 * 4,
      chunk: (results, parser) => {
        const data = results.data;
        let i = 0;
        if (!headerSkipped) { i = 1; headerSkipped = true; }
        for (; i < data.length; i++) {
          const row = data[i];
          if (n >= cap) grow();
          for (let c = 0; c < nCols; c++) {
            const v = row[c];
            const miss = v === undefined || v === null || v === "" || v === "NA" || v === "null" || v === "NULL";
            if (miss) {
              nullCounts[c]++;
              if (matrixFilled < matrixRows) matrix[matrixFilled * nCols + c] = 1;
            }
          }
          if (matrixFilled < matrixRows) matrixFilled++;
          const s = (row[mapping.sender] ?? "").trim();
          const r = (row[mapping.receiver] ?? "").trim();
          sender[n] = accOf(s || "∅MISSING");
          receiver[n] = accOf(r || "∅MISSING");
          amount[n] = mapping.amount >= 0 ? parseAmount(row[mapping.amount] ?? "") : NaN;
          ts[n] = mapping.timestamp >= 0 ? parseTs(row[mapping.timestamp] ?? "") : NaN;
          const md = mapping.mode >= 0 ? (row[mapping.mode] ?? "").trim().toUpperCase() || "UNKNOWN" : "UNKNOWN";
          let mi = modeIndex.get(md);
          if (mi === undefined) { mi = modes.length; modes.push(md); modeIndex.set(md, mi); }
          mode[n] = mi;
          // Module A entity extraction: IFSC, IP anomalies, device profile, narration markers
          if (mapping.ifscS >= 0) { const v = (row[mapping.ifscS] ?? "").trim().toUpperCase(); if (v) accIfsc[sender[n]] = v; }
          if (mapping.ifscR >= 0) { const v = (row[mapping.ifscR] ?? "").trim().toUpperCase(); if (v) accIfsc[receiver[n]] = v; }
          let xf = 0;
          if (mapping.ip >= 0 && /^\s*(185|194)\./.test(row[mapping.ip] ?? "")) xf |= 1;
          if (mapping.device >= 0 && /emulator|script|headless|bot/i.test(row[mapping.device] ?? "")) xf |= 2;
          if (mapping.narration >= 0) {
            const nr = row[mapping.narration] ?? "";
            if (CRYPTO_RE.test(nr)) xf |= 4; else if (WALLET_RE.test(nr)) xf |= 8;
            if (SCAM_RE.test(nr)) xf |= 16;
          }
          xflag[n] = xf;
          txnIds.push(mapping.txnId >= 0 ? (row[mapping.txnId] ?? "").trim() || `ROW-${n + 1}` : `ROW-${n + 1}`);
          if (n < RAW_RETENTION_CAP) rawLines.push(row.join(","));
          n++;
        }
        const now = performance.now();
        if (now - lastReport > 120) {
          lastReport = now;
          onProgress({ rows: n, bytes: results.meta.cursor, totalBytes, phase: "Parsing CSV stream" });
          parser.pause();
          setTimeout(() => parser.resume(), 0);
        }
      },
      complete: () => resolve(),
      error: (err: Error) => reject(err),
    });
  });

  const tParse = performance.now() - t0;
  onProgress({ rows: n, bytes: totalBytes, totalBytes, phase: "Profiling & integrity checks" });
  await new Promise((r) => setTimeout(r, 20));

  const t1 = performance.now();
  sender = sender.slice(0, n);
  receiver = receiver.slice(0, n);
  amount = amount.slice(0, n);
  ts = ts.slice(0, n);
  mode = mode.slice(0, n);
  xflag = xflag.slice(0, n);

  // profiling
  let dupTxn = 0;
  const seenTxn = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = txnIds[i];
    if (seenTxn.has(id)) dupTxn++;
    else seenTxn.add(id);
  }
  seenTxn.clear();
  let dupFull = 0;
  const seenFull = new Set<string>();
  let invalidAmounts = 0, invalidTs = 0, selfTransfers = 0;
  let amin = Infinity, amax = -Infinity, asum = 0, tmin = Infinity, tmax = -Infinity;
  const modeCounts = new Int32Array(modes.length);
  for (let i = 0; i < n; i++) {
    const a = amount[i];
    const t = ts[i];
    if (!(a >= 0)) invalidAmounts++;
    else { if (a < amin) amin = a; if (a > amax) amax = a; asum += a; }
    if (isNaN(t)) invalidTs++;
    else { if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    if (sender[i] === receiver[i]) selfTransfers++;
    modeCounts[mode[i]]++;
    const key = sender[i] + "|" + receiver[i] + "|" + a + "|" + t;
    if (seenFull.has(key)) dupFull++;
    else seenFull.add(key);
  }
  seenFull.clear();
  const inverse: Record<number, MappingKey> = {};
  (Object.keys(mapping) as MappingKey[]).forEach((k) => { if (mapping[k] >= 0) inverse[mapping[k]] = k; });
  const profile: Profile = {
    columns: headers.map((h, c) => ({ name: h, nulls: nullCounts[c], nullPct: n ? (nullCounts[c] / n) * 100 : 0, mapped: inverse[c] ?? null })),
    duplicateTxnIds: dupTxn,
    duplicateFullRows: dupFull,
    invalidAmounts,
    invalidTimestamps: invalidTs,
    selfTransfers,
    amountMin: isFinite(amin) ? amin : 0,
    amountMax: isFinite(amax) ? amax : 0,
    amountSum: asum,
    amountMean: n - invalidAmounts > 0 ? asum / (n - invalidAmounts) : 0,
    tsMin: isFinite(tmin) ? tmin : NaN,
    tsMax: isFinite(tmax) ? tmax : NaN,
    modeDistribution: modes.map((m, i) => ({ mode: m, count: modeCounts[i] })).sort((a, b) => b.count - a.count),
    missingMatrix: matrix,
    missingMatrixRows: matrixFilled,
  };
  const tProfile = performance.now() - t1;

  return {
    name,
    sizeBytes: totalBytes,
    headers,
    rowCount: n,
    accounts,
    accountIndex,
    txnIds,
    sender,
    receiver,
    amount,
    ts,
    mode,
    modes,
    xflag,
    accIfsc,
    rawLines,
    rawRetained: rawLines.length,
    mapping,
    profile,
    timings: { "CSV parse + normalize": tParse, "Profiling & integrity": tProfile },
    source,
  };
}

/** Reconstruct original CSV record for a row. */
export function originalRecord(ds: Dataset, row: number): { raw: string; fields: { header: string; value: string }[]; reconstructed: boolean } {
  if (row < ds.rawRetained) {
    const raw = ds.rawLines[row];
    const parts = Papa.parse<string[]>(raw).data[0] ?? raw.split(",");
    return { raw, fields: ds.headers.map((h, i) => ({ header: h, value: parts[i] ?? "" })), reconstructed: false };
  }
  const m = ds.mapping;
  const fields = ds.headers.map((h, i) => {
    let value = "";
    if (i === m.txnId) value = ds.txnIds[row];
    else if (i === m.sender) value = ds.accounts[ds.sender[row]];
    else if (i === m.receiver) value = ds.accounts[ds.receiver[row]];
    else if (i === m.amount) value = String(ds.amount[row]);
    else if (i === m.timestamp) value = isNaN(ds.ts[row]) ? "" : new Date(ds.ts[row]).toISOString();
    else if (i === m.mode) value = ds.modes[ds.mode[row]];
    return { header: h, value };
  });
  return { raw: fields.map((f) => f.value).join(","), fields, reconstructed: true };
}

// ---------------- Synthetic dataset with planted mule topology ----------------
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSyntheticCSV(rows: number, seed = 42): { csv: string; victims: string[]; mules: string[] } {
  const rnd = mulberry32(seed);
  const MODES = ["UPI", "IMPS", "NEFT", "RTGS", "ATM-CASH", "CARD", "WALLET"];
  const nNormal = Math.max(200, Math.floor(rows / 12));
  const acc = (p: string, i: number) => `${p}${String(i).padStart(8, "0")}`;
  const normal = Array.from({ length: nNormal }, (_, i) => acc("ACC", i + 1));
  const victims = Array.from({ length: 12 }, (_, i) => acc("VIC", i + 1));
  const l1 = Array.from({ length: 10 }, (_, i) => acc("MUL", 100 + i));
  const l2 = Array.from({ length: 18 }, (_, i) => acc("MUL", 200 + i));
  const l3 = Array.from({ length: 30 }, (_, i) => acc("MUL", 300 + i));
  const exits = Array.from({ length: 14 }, (_, i) => acc("EXT", 900 + i));
  const start = Date.UTC(2024, 0, 1);
  const span = 1000 * 60 * 60 * 24 * 90;
  const out: string[] = ["txn_id,sender_account,receiver_account,amount,timestamp,payment_mode,sender_ifsc,receiver_ifsc,narration,ip_address,device_type"];
  const BK = ["SBIN", "HDFC", "ICIC", "UTIB", "PUNB", "BARB", "CNRB", "KKBK", "IDIB", "YESB"];
  const ifscOf = (a: string) => { let h = 7; for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0; return BK[h % 10] + "0" + String(h % 1000000).padStart(6, "0"); };
  let id = 1;
  const push = (s: string, r: string, a: number, t: number, m: string, x?: boolean) => {
    const tsStr = new Date(t).toISOString().replace("T", " ").slice(0, 19);
    const amt = rnd() < 0.004 ? "" : a.toFixed(2);
    const mode = rnd() < 0.006 ? "" : m;
    const oct = () => Math.floor(rnd() * 256);
    const ip = x ? `${rnd() < 0.5 ? 185 : 194}.${oct()}.${oct()}.${oct()}` : `49.${36 + Math.floor(rnd() * 20)}.${oct()}.${oct()}`;
    const dev = x ? (rnd() < 0.5 ? "Web_Emulator" : "Linux_Script") : rnd() < 0.6 ? "Android" : "iOS";
    const nar = x ? (rnd() < 0.5 ? "P2P USDT CRYPTO BUY" : "WALLET GATEWAY TOPUP") : "UPI TRANSFER";
    out.push(`TXN${String(id++).padStart(9, "0")},${s},${r},${amt},${tsStr},${mode},${ifscOf(s)},${ifscOf(r)},${nar},${ip},${dev}`);
  };
  // planted chains: victim -> L1 -> L2 -> L3 -> exit
  const chainTx: { s: string; r: string; a: number; t: number; m: string; x?: boolean }[] = [];
  for (const v of victims) {
    const nFraud = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < nFraud; k++) {
      const t0 = start + rnd() * span;
      const amt = 20000 + Math.floor(rnd() * 180000);
      const c1 = l1[Math.floor(rnd() * l1.length)];
      chainTx.push({ s: v, r: c1, a: amt, t: t0, m: "UPI" });
      let remaining = amt;
      const nSplit = 2 + Math.floor(rnd() * 3);
      for (let j = 0; j < nSplit; j++) {
        const part = j === nSplit - 1 ? remaining : Math.floor(remaining * (0.3 + rnd() * 0.3));
        remaining -= part;
        const d = l2[Math.floor(rnd() * l2.length)];
        const t1 = t0 + (5 + rnd() * 40) * 60000;
        chainTx.push({ s: c1, r: d, a: part, t: t1, m: "IMPS" });
        const nL3 = 1 + Math.floor(rnd() * 3);
        let rem2 = part;
        for (let q = 0; q < nL3; q++) {
          const p2 = q === nL3 - 1 ? rem2 : Math.floor(rem2 * 0.5);
          rem2 -= p2;
          const l3a = l3[Math.floor(rnd() * l3.length)];
          const t2 = t1 + (3 + rnd() * 30) * 60000;
          // structuring: just under 50k
          const amtL3 = p2 > 50000 ? 49000 + Math.floor(rnd() * 999) : p2;
          chainTx.push({ s: d, r: l3a, a: amtL3, t: t2, m: "IMPS" });
          const ex = exits[Math.floor(rnd() * exits.length)];
          const t3 = t2 + (2 + rnd() * 25) * 60000;
          chainTx.push({ s: l3a, r: ex, a: Math.floor(amtL3 * (0.9 + rnd() * 0.1)), t: t3, m: rnd() < 0.5 ? "ATM-CASH" : "WALLET", x: true });
          if (rnd() < 0.08) chainTx.push({ s: ex, r: c1, a: Math.floor(amtL3 * 0.1), t: t3 + 3600000, m: "UPI" }); // cycle-back
        }
      }
    }
  }
  // mule burst noise: many small inflows to L1 from random accounts
  for (const m of l1) {
    const t0 = start + rnd() * span;
    const burst = 12 + Math.floor(rnd() * 20);
    for (let k = 0; k < burst; k++) chainTx.push({ s: normal[Math.floor(rnd() * nNormal)], r: m, a: 1000 + Math.floor(rnd() * 9000), t: t0 + rnd() * 3 * 3600000, m: "UPI" });
  }
  const noiseRows = Math.max(0, rows - chainTx.length);
  const allTx = chainTx.slice();
  for (let i = 0; i < noiseRows; i++) {
    const s = normal[Math.floor(rnd() * nNormal)];
    let r = normal[Math.floor(rnd() * nNormal)];
    if (r === s) r = normal[(normal.indexOf(s) + 1) % nNormal];
    const a = rnd() < 0.7 ? Math.floor(rnd() * 5000) + 50 : Math.floor(rnd() * 80000) + 500;
    allTx.push({ s, r, a, t: start + rnd() * span, m: MODES[Math.floor(rnd() * MODES.length)] });
  }
  // light shuffle so planted rows are interleaved
  for (let i = allTx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = allTx[i]; allTx[i] = allTx[j]; allTx[j] = tmp;
  }
  for (const t of allTx) push(t.s, t.r, t.a, t.t, t.m, t.x);
  // a few duplicate rows
  for (let i = 0; i < Math.min(25, allTx.length); i++) out.push(out[1 + Math.floor(rnd() * (out.length - 1))]);
  return { csv: out.join("\n"), victims, mules: [...l1, ...l2, ...l3] };
}
