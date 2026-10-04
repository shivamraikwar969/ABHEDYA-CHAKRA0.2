/**
 * Browser-only accounts - used automatically when the auth service (npm run llm) is not reachable.
 *
 *  * Password -> SHA-256 -> base64 (so bcrypt's 72-byte limit can never silently truncate a long passphrase) -> bcrypt cost 12,
 *    random per-account salt (bcrypt embeds it). Only the bcrypt hash is stored, never the password.
 *  * Brute force: 5 wrong passwords lock that username for 30 s, doubling each further failure (cap 15 min).
 *  * Timing: unknown usernames burn one bcrypt comparison too, so response time does not reveal which usernames exist.
 *
 * HONEST LIMIT: everything here lives in the user's own browser. Anyone with DevTools on this machine can clear or edit
 * localStorage, so local mode is a convenience gate, not a security boundary. Real enforcement needs the server (REQUIRE_AUTH=1).
 */
const USERS = "rk.local.users.v1", LOCKS = "rk.local.locks.v1";
const COST = 12, MIN_LEN = 12, MAX_LEN = 128;

type Bcrypt = { hash(s: string, rounds: number): Promise<string>; compare(s: string, h: string): Promise<boolean> };
let bc: Bcrypt | null = null;
async function bcrypt(): Promise<Bcrypt> {
  if (!bc) { const m = await import("bcryptjs"); bc = ((m as unknown as { default?: Bcrypt }).default ?? (m as unknown as Bcrypt)); }
  return bc;
}

async function prehash(pw: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw)));
  let s = ""; for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

function read<T>(k: string, fb: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fb; } catch { return fb; } }
function write(k: string, v: unknown): boolean { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

type Users = Record<string, { hash: string; created: number }>;
type Locks = Record<string, { n: number; until: number }>;
const norm = (u: string) => u.trim().toLowerCase();

export type LocalResult = { ok: true } | { ok: false; reason: string };

export function passwordProblem(pw: string, username: string): string | null {
  if (pw.length < MIN_LEN) return `Password must be at least ${MIN_LEN} characters.`;
  if (pw.length > MAX_LEN) return `Password must be at most ${MAX_LEN} characters.`;
  if (username.length >= 3 && pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain your username.";
  return null;
}

export const hasLocalAccounts = () => Object.keys(read<Users>(USERS, {})).length > 0;

export async function localSignUp(username: string, password: string): Promise<LocalResult> {
  const u = norm(username);
  const bad = passwordProblem(password, u);
  if (bad) return { ok: false, reason: bad };
  const users = read<Users>(USERS, {});
  if (users[u]) return { ok: false, reason: "That username is not available." };
  users[u] = { hash: await (await bcrypt()).hash(await prehash(password), COST), created: Date.now() };
  return write(USERS, users) ? { ok: true } : { ok: false, reason: "This browser blocked local storage, so an offline account cannot be saved." };
}

let dummy: string | null = null;
export async function localSignIn(username: string, password: string): Promise<LocalResult> {
  const u = norm(username), now = Date.now();
  const locks = read<Locks>(LOCKS, {});
  if ((locks[u]?.until ?? 0) > now) return { ok: false, reason: `Too many attempts - try again in ${Math.ceil((locks[u].until - now) / 1000)} s.` };
  const b = await bcrypt(), users = read<Users>(USERS, {}), rec = users[u];
  const pre = await prehash(password);
  dummy ??= await b.hash("rakshak-dummy", COST);
  const ok = await b.compare(pre, rec ? rec.hash : dummy);
  if (!rec || !ok) {
    const n = (locks[u]?.n ?? 0) + 1;
    locks[u] = { n, until: n >= 5 ? now + Math.min(900_000, 30_000 * 2 ** (n - 5)) : 0 };
    write(LOCKS, locks);
    return { ok: false, reason: !rec && !hasLocalAccounts() ? "No offline account exists yet - use Sign up first." : "Invalid username or password." };
  }
  delete locks[u]; write(LOCKS, locks);
  return { ok: true };
}
