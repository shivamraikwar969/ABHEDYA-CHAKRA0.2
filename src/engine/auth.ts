/**
 * Sign-in / sign-up client for the local API (server/llm-server.mjs).
 * The session token is kept ONLY in memory - never in localStorage / sessionStorage / cookies - so an XSS bug cannot lift it
 * from disk, and closing or reloading the tab signs you out. Every API call in llm.ts carries the token via authHeaders().
 */
const BASE: string = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_LLM_URL ?? "http://127.0.0.1:8787";

let token: string | null = null;
let expiresAt = 0;
let who = "";
let local = false;

export const authHeaders = (): Record<string, string> => (token && Date.now() < expiresAt ? { Authorization: `Bearer ${token}` } : {});
export const isSignedIn = () => (!!token || local) && Date.now() < expiresAt;
export const currentUser = () => who;
export const isLocalSession = () => local;

export type AuthResult = { ok: true; local?: boolean } | { ok: false; reason: string; offline?: boolean };

async function call(path: string, body: unknown): Promise<{ status: number; j: Record<string, unknown> } | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", signal: AbortSignal.timeout(20_000) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  } catch { return null; }
}
const OFFLINE: AuthResult = { ok: false, offline: true, reason: "Auth service not reachable. Start it in a second terminal:  npm run llm" };
const nice = (j: Record<string, unknown>, fb: string) => String(j.reason ?? fb).replace(/^Request rejected: /, "");

export async function signIn(username: string, password: string): Promise<AuthResult> {
  const r = await call("/api/auth/login", { username, password });
  if (!r) return OFFLINE;
  if (r.status !== 200 || !r.j.ok) return { ok: false, reason: r.status === 429 ? nice(r.j, "Too many attempts - wait a moment and try again.") : nice(r.j, "Sign-in failed") };
  local = false; token = String(r.j.token); expiresAt = Date.parse(String(r.j.expiresAt)) || Date.now() + 3_600_000;
  who = String((r.j.user as { username?: string } | undefined)?.username ?? username);
  return { ok: true };
}

/** Creates the account and signs straight in. */
export async function signUp(username: string, password: string): Promise<AuthResult> {
  const r = await call("/api/auth/register", { username, password });
  if (!r) return OFFLINE;
  if (r.status !== 201 || !r.j.ok) return { ok: false, reason: nice(r.j, "Sign-up failed") };
  return signIn(username, password);
}

export async function signOut(): Promise<void> {
  try { await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: "{}", credentials: "omit" }); } catch { /* offline */ }
  token = null; expiresAt = 0; who = ""; local = false;
}

/** Quick reachability probe so the login page can say whether it will use the server or this browser. */
export async function serverReachable(): Promise<boolean> {
  try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500), credentials: "omit" })).ok; } catch { return false; }
}

/**
 * Server first. ONLY when the server cannot be reached at all do we fall back to browser-only accounts (engine/localAuth.ts).
 * A reachable server that says "wrong password" is final - we never fall back then, or the fallback would be a bypass.
 */
export async function authenticate(mode: "login" | "signup", username: string, password: string): Promise<AuthResult> {
  const r = mode === "signup" ? await signUp(username, password) : await signIn(username, password);
  if (r.ok || !("offline" in r && r.offline)) return r;
  const L = await import("./localAuth");
  const res = mode === "signup" ? await L.localSignUp(username, password) : await L.localSignIn(username, password);
  if (!res.ok) return { ok: false, reason: res.reason, offline: true };
  if (mode === "signup") { const again = await L.localSignIn(username, password); if (!again.ok) return { ok: false, reason: again.reason, offline: true }; }
  token = null; local = true; who = username.trim().toLowerCase(); expiresAt = Date.now() + 8 * 3_600_000;
  return { ok: true, local: true };
}
