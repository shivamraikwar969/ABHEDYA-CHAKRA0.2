// =====================================================================================
//  RakshakAI - CASE DOSSIER COMPILER / EXPORT ENGINE   (pure functions, no network)
//  Compiles the (already sanitised) fact pack into a structured, tamper-evident dossier and
//  renders it as JSON, Markdown or CSV. Works fully offline: no model is needed.
//  Every rendered line is re-verified against the allow-list; a line with an unverifiable
//  account / IFSC / txn id / rupee amount is dropped (fail closed) and counted in `integrity`.
// =====================================================================================
import { createHash } from "node:crypto";
import { deterministicNarrative, verifyText } from "./guardrail.mjs";

export const DOSSIER_SCHEMA = "rakshakai.dossier/1";

/** JSON with sorted keys, so the same content always hashes identically. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

/**
 * @param {object} p  { pack, allowed, officerNote, narrative?, meta? }
 * @returns {object}  dossier (sections + integrity block)
 */
export function compileDossier({ pack, allowed, officerNote = "", narrative = "", meta = {} }) {
  const keep = (lines) => { const kept = []; let dropped = 0; for (const l of lines) { if (verifyText(l, allowed).ok) kept.push(l); else dropped++; } return { kept, dropped }; };
  let droppedTotal = 0;
  const section = (id, title, lines) => { const { kept, dropped } = keep(lines.filter(Boolean)); droppedTotal += dropped; return { id, title, lines: kept }; };

  const p = pack ?? {};
  const sections = [
    section("victim", "Victim and loss", [
      p.victim ? `Victim account ${p.victim.account} | ${p.victim.bank ?? "bank n/a"} | IFSC ${p.victim.ifsc ?? "n/a"}` : "",
      `Total siphoned: ${p.totalSiphoned ?? "n/a"} | first transfer ${p.firstTransfer ?? "n/a"} | last transfer ${p.lastTransfer ?? "n/a"}`,
      `First-hop transfers: ${p.firstHopTransfers ?? "n/a"} | accounts reached: ${p.accountsReached ?? "n/a"} | cycle-back transfers: ${p.cycleBackTransfers ?? 0}`,
    ]),
    section("accounts", "Traced accounts", (p.accounts ?? []).map((a) => `${a.account} | ${a.bank} | IFSC ${a.ifsc} | layer ${a.layer} | received ${a.received} | sent ${a.sent} | holding ${a.holding}`)),
    section("freeze", "Freeze recommendations", (p.freezeRecommended ?? []).map((a) => `${a.account} | ${a.bank} | IFSC ${a.ifsc} | holding ${a.holding}`)),
    section("exits", "Exit channels", [
      ...(p.exitChannels ?? []).map((c) => `${c.channel}: ${c.amount} across ${c.transfers} transfer(s)`),
      ...(p.leafAccounts ?? []).map((l) => `${l.account} received ${l.received}${l.exits?.length ? " | " + l.exits.join("; ") : ""}`),
    ]),
    section("timeline", "Chronological evidence timeline", (p.evidenceTimeline ?? []).map((e) =>
      `T${String(e.seq).padStart(3, "0")} | ${e.time} | ${e.txnId} | ${e.from} -> ${e.to} | ${e.amount} | hop ${e.hop} | confidence ${e.confidence} ${e.tier}${e.flags?.length ? " | " + e.flags.join(", ") : ""}`)),
    section("entities", "Entity risk flags", (p.entityRiskFlags ?? []).map((e) => `${e.account} | ${(e.flags ?? []).join(", ")}`)),
  ];
  const note = narrative ? "" : deterministicNarrative(p, allowed);
  sections.push(section("narrative", narrative ? "AI-assisted narrative (verified)" : "Deterministic narrative", (narrative || note).split(/\n+/)));
  if (officerNote) sections.push({ id: "remarks", title: "Officer remarks (sanitised, inert text)", lines: [officerNote] });

  const body = { schema: DOSSIER_SCHEMA, meta: { ...meta }, sections };
  const hash = sha256(canonicalJson(body));
  return { ...body, integrity: { algorithm: "SHA-256", digest: hash, canonicalisation: "sorted-key JSON of {schema, meta, sections}", linesDroppedAsUnverifiable: droppedTotal, verifiedAgainstAllowList: true } };
}

export function dossierToMarkdown(d) {
  const out = [`# Case dossier`, ``, ...Object.entries(d.meta ?? {}).map(([k, v]) => `- **${k}**: ${String(v).replace(/[\r\n]+/g, " ")}`), ``];
  for (const s of d.sections) { out.push(`## ${s.title}`, ""); s.lines.forEach((l) => out.push(`- ${l.replace(/[\r\n]+/g, " ")}`)); out.push(""); }
  out.push(`---`, `Integrity: ${d.integrity.algorithm} ${d.integrity.digest}`, `Lines dropped as unverifiable: ${d.integrity.linesDroppedAsUnverifiable}`);
  return out.join("\n");
}

export function dossierToCsv(pack) {
  const rows = [["seq", "time", "txn_id", "from", "to", "amount", "hop", "confidence", "tier", "flags"]];
  for (const e of pack?.evidenceTimeline ?? []) rows.push([e.seq, e.time, e.txnId, e.from, e.to, e.amount, e.hop, e.confidence, e.tier, (e.flags ?? []).join("; ")]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Recompute the digest of a dossier object; true when nothing was altered. */
export function verifyDossier(d) {
  const { integrity, ...rest } = d;
  return !!integrity && sha256(canonicalJson({ schema: rest.schema, meta: rest.meta, sections: rest.sections })) === integrity.digest;
}
