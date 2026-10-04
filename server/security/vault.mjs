// =====================================================================================
//  ENCRYPTED DOSSIER VAULT  -  case dossiers / evidence packs are stored ONLY as AES-256-GCM ciphertext (server/.data/vault/)
//  File name = random 128-bit id (no case data in names). Context-bound: <owner>:<id>. Owner-scoped access (admins see all).
// =====================================================================================
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decryptBuffer, encryptBuffer } from "./crypto.mjs";
import { DATA_DIR } from "./auth.mjs";

const DIR = path.join(DATA_DIR, "vault");
const ID_RE = /^[a-f0-9]{32}$/;

export function vaultPut(owner, obj) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const id = randomBytes(16).toString("hex");
  const file = path.join(DIR, id + ".enc");
  // header (owner + created) is bound into the AAD, so a file cannot be re-assigned to another user
  const created = new Date().toISOString();
  writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify({ o: owner, c: created }) + "\n"), encryptBuffer(Buffer.from(JSON.stringify(obj)), `vault:${owner}:${id}`)]), { mode: 0o600, flag: "wx" });
  try { chmodSync(file, 0o600); } catch { /* non-POSIX */ }
  return { id, created };
}

function readEntry(id) {
  if (!ID_RE.test(id)) return null; // also blocks path traversal: only 32 hex chars ever reach the filesystem
  const file = path.join(DIR, id + ".enc");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  const nl = raw.indexOf(10);
  return { head: JSON.parse(raw.subarray(0, nl).toString("utf8")), blob: raw.subarray(nl + 1) };
}

export function vaultGet(user, id) {
  const e = readEntry(id);
  if (!e || (e.head.o !== user.id && user.role !== "admin")) return null; // same answer for "missing" and "not yours"
  return { id, created: e.head.c, data: JSON.parse(decryptBuffer(e.blob, `vault:${e.head.o}:${id}`).toString("utf8")) };
}

export function vaultList(user) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith(".enc")).map((f) => f.slice(0, -4)).map((id) => ({ id, e: readEntry(id) }))
    .filter(({ e }) => e && (e.head.o === user.id || user.role === "admin")).map(({ id, e }) => ({ id, created: e.head.c })).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, 200);
}
