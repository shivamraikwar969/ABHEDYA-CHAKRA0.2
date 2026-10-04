// =====================================================================================
//  USERS + SESSIONS
//   * Users live in an atomically-written JSON file (server/.data/users.json, mode 0600). Username and the password
//     hash are AES-256-GCM encrypted per field (context-bound to the record id). Lookup uses an HMAC blind index of the username.
//   * Passwords: Argon2id (+ pepper), see passwords.mjs. Hashes are upgraded transparently on login.
//   * Brute force: per-account lockout with exponential back-off (5 failures -> 1 min, doubling, capped at 1 h), on top of the
//     per-IP and per-account rate limits in the HTTP layer. Unknown users burn the same CPU as real ones (no enumeration).
//   * Sessions: stateless HMAC-SHA256 signed tokens (`v1.<payload>.<sig>`), short TTL, revocable (logout / password change bumps
//     the user's `tv` counter), checked with timingSafeEqual. Token key is HKDF-separated from the encryption key.
//   * Registration: the first account becomes admin; later accounts are analysts (self-service only while ALLOW_OPEN_SIGNUP=1, otherwise admin-created).
// =====================================================================================
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blindIndex, decryptField, encryptField, safeEqual } from "./crypto.mjs";
import { activeKey, deriveKey } from "./keys.mjs";
import { dummyVerify, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from "./passwords.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.RAKSHAK_DATA_DIR || path.resolve(HERE, "..", ".data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSION_TTL_SEC = Number(process.env.SESSION_TTL_SEC || 3600);

export class AuthError extends Error { constructor(msg, status = 401, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }

// ---------- storage ----------
let cache = null;
function ensureDir() { mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function load() {
  if (cache) return cache;
  cache = existsSync(USERS_FILE) ? JSON.parse(readFileSync(USERS_FILE, "utf8")) : { users: [] };
  return cache;
}
function save() {
  ensureDir();
  const tmp = USERS_FILE + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  renameSync(tmp, USERS_FILE); // atomic replace: a crash never leaves a half-written user file
  try { chmodSync(USERS_FILE, 0o600); } catch { /* non-POSIX */ }
}
export function _resetAuthCache() { cache = null; }

const usernameIdx = (username) => blindIndex(username, "users.username");
const findByUsername = (username) => load().users.find((u) => safeEqual(u.usernameIdx, usernameIdx(username)));
const ctx = (id, f) => `users.${f}:${id}`;
const publicUser = (u) => ({ id: u.id, username: decryptField(u.username, ctx(u.id, "username")), role: u.role });

// ---------- tokens ----------
const tokenKey = () => deriveKey(activeKey().key, "session-token");
const b64u = (b) => Buffer.from(b).toString("base64url");
export function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return `v1.${body}.${createHmac("sha256", tokenKey()).update("v1." + body).digest("base64url")}`;
}
export function verifyToken(token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [v, body, sig] = token.split(".");
  if (v !== "v1" || !body || !sig) return null;
  const want = createHmac("sha256", tokenKey()).update("v1." + body).digest("base64url");
  if (!safeEqual(sig, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p || typeof p.sub !== "string" || typeof p.exp !== "number" || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch { return null; }
}

/** Resolve `Authorization: Bearer <token>` to a live user, or null. Checks revocation (tv) against the stored user. */
export function authenticate(req) {
  const h = String(req.headers?.authorization || "");
  const m = /^Bearer ([\w.-]+)$/.exec(h);
  const p = m && verifyToken(m[1]);
  if (!p) return null;
  const u = load().users.find((x) => x.id === p.sub);
  if (!u || u.tv !== p.tv) return null;
  return { id: u.id, role: u.role, exp: p.exp };
}

// ---------- operations ----------
export function userCount() { return load().users.length; }

/** Self-service sign-up: ON by default in development, OFF by default in production (ALLOW_OPEN_SIGNUP=1 to enable). */
const openSignup = () => (process.env.ALLOW_OPEN_SIGNUP ?? (process.env.NODE_ENV === "production" ? "0" : "1")) === "1";

export async function register({ username, password, role = "analyst" }, actor) {
  const first = userCount() === 0;
  if (!first && actor?.role !== "admin" && !openSignup()) throw new AuthError("registration is closed - an administrator must create accounts", 403);
  const pol = passwordPolicyError(password, { username });
  if (pol) throw new AuthError(pol, 400);
  if (findByUsername(username)) throw new AuthError("that username is not available", 409);
  const id = randomBytes(16).toString("hex");
  const u = {
    id, usernameIdx: usernameIdx(username), username: encryptField(username, ctx(id, "username")),
    pw: encryptField(await hashPassword(password), ctx(id, "pw")), role: first ? "admin" : actor?.role === "admin" && role === "admin" ? "admin" : "analyst", // anonymous sign-ups can never self-promote
    failed: 0, lockedUntil: 0, tv: 0, createdAt: new Date().toISOString(),
  };
  load().users.push(u); save();
  return publicUser(u);
}

export async function login({ username, password }) {
  const u = findByUsername(username);
  const now = Date.now();
  if (!u) { await dummyVerify(password); throw new AuthError("invalid username or password"); }
  if (u.lockedUntil > now) { await dummyVerify(password); throw new AuthError("account temporarily locked - try again later", 429, { retryAfterSec: Math.ceil((u.lockedUntil - now) / 1000) }); }
  const stored = decryptField(u.pw, ctx(u.id, "pw"));
  if (!(await verifyPassword(password, stored))) {
    u.failed = (u.failed || 0) + 1;
    if (u.failed >= 5) u.lockedUntil = now + Math.min(3_600_000, 60_000 * 2 ** (u.failed - 5));
    save();
    throw new AuthError("invalid username or password");
  }
  u.failed = 0; u.lockedUntil = 0;
  if (await needsRehash(stored)) u.pw = encryptField(await hashPassword(password), ctx(u.id, "pw")); // silent upgrade to current cost / algorithm
  save();
  const exp = Math.floor(now / 1000) + SESSION_TTL_SEC;
  return { token: signToken({ sub: u.id, role: u.role, tv: u.tv, iat: Math.floor(now / 1000), exp, jti: randomBytes(8).toString("hex") }), expiresAt: new Date(exp * 1000).toISOString(), user: publicUser(u) };
}

/** Revoke every outstanding token of this user. */
export function logoutAll(userId) { const u = load().users.find((x) => x.id === userId); if (u) { u.tv++; save(); } }
export function me(userId) { const u = load().users.find((x) => x.id === userId); return u ? publicUser(u) : null; }
