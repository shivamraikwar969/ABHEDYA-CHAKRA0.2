// =====================================================================================
//  KEY MANAGEMENT  -  one master key ring, HKDF-derived purpose keys (never reuse a key across purposes)
//
//  Production:  RAKSHAK_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"   (first = active, rest = decrypt-only, for rotation)
//  Generate:    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//  Development: if RAKSHAK_KEYS is unset a random key is created in server/.secrets/master.key (mode 0600, git-ignored).
//               With NODE_ENV=production a missing key is a hard startup error (fail closed).
// =====================================================================================
import { hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SECRETS_DIR = process.env.RAKSHAK_SECRETS_DIR || path.resolve(HERE, "..", ".secrets");

let ring = null; // [{ id, key:Buffer(32) }]

function parseRing(spec) {
  const out = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const id = i > 0 ? part.slice(0, i) : "k1";
    const b64 = i > 0 ? part.slice(i + 1) : part;
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new Error(`RAKSHAK_KEYS: invalid key id "${id}"`);
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new Error(`RAKSHAK_KEYS: key "${id}" must be exactly 32 bytes (base64)`);
    if (out.some((k) => k.id === id)) throw new Error(`RAKSHAK_KEYS: duplicate key id "${id}"`);
    out.push({ id, key });
  }
  if (!out.length) throw new Error("RAKSHAK_KEYS is empty");
  return out;
}

export function loadKeyRing() {
  if (ring) return ring;
  if (process.env.RAKSHAK_KEYS) return (ring = parseRing(process.env.RAKSHAK_KEYS));
  if (process.env.NODE_ENV === "production") throw new Error("RAKSHAK_KEYS must be set in production (refusing to generate a key on disk).");
  const file = path.join(SECRETS_DIR, "master.key");
  if (!existsSync(file)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, "k1:" + randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
    console.warn(`[security] generated a DEVELOPMENT master key at ${file}. Set RAKSHAK_KEYS in production.`);
  }
  try { chmodSync(file, 0o600); } catch { /* best effort (non-POSIX fs) */ }
  return (ring = parseRing(readFileSync(file, "utf8")));
}

/** Test hook. */
export function _resetKeyRing() { ring = null; }

export const activeKey = () => loadKeyRing()[0];
export const keyById = (id) => loadKeyRing().find((k) => k.id === id);

/** Purpose-bound 32-byte key: HKDF-SHA256(master, salt, info). */
export function deriveKey(master, purpose, salt = Buffer.alloc(0)) {
  return Buffer.from(hkdfSync("sha256", master, salt, "rakshakai/v1/" + purpose, 32));
}
