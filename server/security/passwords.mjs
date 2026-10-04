// =====================================================================================
//  PASSWORD HASHING
//
//  Primary:  Argon2id (RFC 9106)  m=64 MiB, t=3, p=4, 16-byte per-user random salt, 32-byte tag   [npm: argon2]
//  Fallback: scrypt N=2^17 r=8 p=1 (128 MiB), 16-byte per-user random salt   [node:crypto, used only if `argon2` is not installed;
//            set REQUIRE_ARGON2=1 to refuse to start without it]. Both are memory-hard; both verify side by side, so hashes
//            migrate automatically on the next successful login (needsRehash).
//
//  Hardening on top of the KDF:
//   * Pepper: the password is first run through HMAC-SHA256 with a server-side key that never lives in the database. A stolen
//     DB alone cannot be attacked offline. It also removes bcrypt-style length limits and makes huge inputs a fixed cost.
//   * Concurrency gate: memory-hard hashing is expensive by design, so only N run at once and the queue is bounded -
//     a login flood gets 503 instead of exhausting RAM / serverless billing (Denial-of-Wallet).
//   * Constant-time verification, and a dummy verification for unknown users to equalise timing (no account enumeration).
// =====================================================================================
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { activeKey, deriveKey } from "./keys.mjs";

const scrypt = promisify(scryptCb);
const ARGON = { memoryCost: Number(process.env.ARGON2_MEMORY_KIB || 65536), timeCost: Number(process.env.ARGON2_TIME || 3), parallelism: Number(process.env.ARGON2_PARALLELISM || 4), hashLength: 32 };
const SCRYPT = { ln: Number(process.env.SCRYPT_LOG_N || 17), r: 8, p: 1, keylen: 32 };
export const MIN_LEN = 12, MAX_LEN = 128;

let argon = undefined; // undefined = not tried, null = unavailable
async function getArgon() {
  if (argon !== undefined) return argon;
  try { argon = (await import("argon2")).default ?? (await import("argon2")); }
  catch {
    argon = null;
    if (process.env.REQUIRE_ARGON2 === "1") throw new Error("REQUIRE_ARGON2=1 but the `argon2` package is not installed (npm i argon2).");
    console.warn("[security] `argon2` not installed - using the scrypt (N=2^17) fallback. Run `npm i argon2` to enable Argon2id.");
  }
  return argon;
}
export const passwordAlgorithm = async () => ((await getArgon()) ? "argon2id" : "scrypt");

// ---- bounded concurrency ----
const MAX_CONCURRENT = Number(process.env.HASH_CONCURRENCY || 2), MAX_QUEUE = Number(process.env.HASH_QUEUE || 16);
let running = 0; const waiters = [];
export class Busy extends Error { constructor() { super("server busy - try again shortly"); this.status = 503; } }
async function gate(fn) {
  if (running >= MAX_CONCURRENT) {
    if (waiters.length >= MAX_QUEUE) throw new Busy();
    await new Promise((res) => waiters.push(res));
  }
  running++;
  try { return await fn(); } finally { running--; waiters.shift()?.(); }
}

const peppered = (pw) => createHmac("sha256", deriveKey(activeKey().key, "password-pepper")).update(pw.normalize("NFKC")).digest("base64");

/** Returns null when OK, otherwise a human-readable reason. Length-first policy (NIST SP 800-63B): no silly composition rules. */
const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "iloveyou1234", "administrator", "letmein123456", "welcome12345", "changeme1234"]);
export function passwordPolicyError(pw, { username = "" } = {}) {
  if (typeof pw !== "string") return "password must be a string";
  if (pw.length < MIN_LEN) return `password must be at least ${MIN_LEN} characters`;
  if (pw.length > MAX_LEN) return `password must be at most ${MAX_LEN} characters`;
  if (/[\u0000-\u001f\u007f]/.test(pw)) return "password contains control characters";
  if (COMMON.has(pw.toLowerCase())) return "password is too common";
  if (/^(.)\1+$/.test(pw)) return "password is too repetitive";
  const local = String(username).toLowerCase();
  if (local.length >= 3 && pw.toLowerCase().includes(local)) return "password must not contain your username";
  return null;
}

export async function hashPassword(pw) {
  const a = await getArgon();
  const input = peppered(pw);
  return gate(async () => {
    if (a) return a.hash(input, { type: a.argon2id, ...ARGON }); // salt: 16 random bytes generated per call by the library
    const salt = randomBytes(16);
    const h = await scrypt(input, salt, SCRYPT.keylen, { N: 2 ** SCRYPT.ln, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
    return `$scrypt$ln=${SCRYPT.ln},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString("base64url")}$${h.toString("base64url")}`;
  });
}

export async function verifyPassword(pw, stored) {
  if (typeof pw !== "string" || pw.length > MAX_LEN || typeof stored !== "string") return false;
  const input = peppered(pw);
  if (stored.startsWith("$argon2")) {
    const a = await getArgon();
    if (!a) return false; // cannot verify without the library; fail closed
    return gate(async () => { try { return await a.verify(stored, input); } catch { return false; } });
  }
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ln > 20 || r > 16 || p > 4) return false; // refuse attacker-chosen absurd parameters
  const salt = Buffer.from(m[4], "base64url"), want = Buffer.from(m[5], "base64url");
  return gate(async () => {
    const got = await scrypt(input, salt, want.length, { N: 2 ** ln, r, p, maxmem: 512 * 1024 * 1024 });
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** true when the stored hash is weaker than the current policy (different algorithm or lower cost) -> re-hash after a successful login. */
export async function needsRehash(stored) {
  const a = await getArgon();
  if (a) {
    if (!stored.startsWith("$argon2id$")) return true;
    try { return a.needsRehash(stored, { ...ARGON }); } catch { return true; }
  }
  const m = /^\$scrypt\$ln=(\d+)/.exec(stored);
  return !m || Number(m[1]) < SCRYPT.ln;
}

let dummy = null;
/** Burn the same CPU/memory as a real check so response time does not reveal whether an account exists. */
export async function dummyVerify(pw) {
  dummy ??= await hashPassword("rakshak-dummy-password-for-timing");
  await verifyPassword(typeof pw === "string" ? pw : "", dummy);
  return false;
}
