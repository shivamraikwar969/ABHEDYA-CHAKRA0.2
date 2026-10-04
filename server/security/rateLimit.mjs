// =====================================================================================
//  RATE LIMITING / DENIAL-OF-WALLET PROTECTION   (runtime-agnostic: Node, Vercel Edge, Cloudflare - Web APIs only)
//
//  * Sliding-window-counter algorithm (two weighted buckets): smooth, O(1) memory per key, no burst-at-boundary loophole.
//  * Stores:  MemoryStore (default, per process / per edge isolate)  and  UpstashStore (REST, shared across ALL serverless
//    instances; set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). If the shared store is unreachable the limiter
//    degrades to the in-memory store rather than failing open.
//  * Tiers (see TIERS): each route class has its own budget. Expensive routes (LLM) are also guarded by a concurrency cap
//    and a global daily budget, so a bot swarm - even one rotating IPs - cannot run up an unbounded bill.
// =====================================================================================

export class MemoryStore {
  constructor(maxKeys = 50_000) { this.m = new Map(); this.maxKeys = maxKeys; this.lastSweep = 0; }
  /** @returns {{count:number, prev:number, windowStart:number}} after counting this hit */
  async hit(key, windowMs, now = Date.now()) {
    const ws = Math.floor(now / windowMs) * windowMs;
    if (now - this.lastSweep > windowMs || this.m.size > this.maxKeys) this.sweep(now);
    // a key flood must not grow memory without bound: past the cap, new keys share one overflow bucket (shared = stricter, never open)
    const k = this.m.size >= this.maxKeys && !this.m.has(key) ? "__overflow__" : key;
    let e = this.m.get(k);
    if (!e || e.ws < ws - windowMs) e = { ws, count: 0, prev: 0, win: windowMs };
    else if (e.ws < ws) { e = { ws, count: 0, prev: e.count, win: windowMs }; }
    e.count++; e.win = windowMs;
    this.m.set(k, e);
    return { count: e.count, prev: e.prev, windowStart: ws };
  }
  sweep(now) { this.lastSweep = now; for (const [k, e] of this.m) if (now - e.ws > 2 * e.win) this.m.delete(k); if (this.m.size > this.maxKeys) for (const k of [...this.m.keys()].slice(0, this.m.size - this.maxKeys)) this.m.delete(k); }
}

/** Upstash Redis over REST (works on Vercel Edge / serverless). Fixed-bucket INCR + PEXPIRE, two buckets read for the sliding estimate. */
export class UpstashStore {
  constructor(url, token, fallback = new MemoryStore(), timeoutMs = 800) { this.url = url.replace(/\/$/, ""); this.token = token; this.fallback = fallback; this.timeoutMs = timeoutMs; }
  async hit(key, windowMs, now = Date.now()) {
    const ws = Math.floor(now / windowMs) * windowMs;
    const cur = `rl:${key}:${ws}`, prev = `rl:${key}:${ws - windowMs}`;
    try {
      const r = await fetch(`${this.url}/pipeline`, {
        method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([["INCR", cur], ["PEXPIRE", cur, String(windowMs * 2)], ["GET", prev]]), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) throw new Error("upstash " + r.status);
      const j = await r.json();
      return { count: Number(j[0].result), prev: Number(j[2].result || 0), windowStart: ws };
    } catch { return this.fallback.hit(key, windowMs, now); }
  }
}

export function storeFromEnv(env = (typeof process !== "undefined" ? process.env : {})) {
  return env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN) : new MemoryStore();
}

/** Route classes. `max` requests per `windowMs`, per client key. Tune with care: auth is deliberately tiny. */
export const TIERS = {
  global: { windowMs: 60_000, max: 120 },        // every API call, per IP
  auth: { windowMs: 15 * 60_000, max: 20 },       // login/register, per IP
  authAccount: { windowMs: 15 * 60_000, max: 5 }, // login attempts per target account (stops distributed guessing against one user)
  llm: { windowMs: 60_000, max: 10 },             // /api/narrate (expensive), per IP
  heavy: { windowMs: 60_000, max: 30 },           // dossier / vault
  budget: { windowMs: 24 * 3_600_000, max: 2000 },// whole-service daily ceiling for narrate calls
};

export function createLimiter(store = new MemoryStore()) {
  /** @returns {{allowed:boolean, remaining:number, limit:number, retryAfterSec:number}} */
  return async function check(tier, key, now = Date.now()) {
    const t = typeof tier === "string" ? TIERS[tier] : tier;
    const r = await store.hit(`${typeof tier === "string" ? tier : "custom"}:${key}`, t.windowMs, now);
    const elapsed = (now - r.windowStart) / t.windowMs;
    const estimate = r.prev * (1 - elapsed) + r.count; // sliding-window estimate
    const allowed = estimate <= t.max;
    return { allowed, limit: t.max, remaining: Math.max(0, Math.floor(t.max - estimate)), retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((t.windowMs - (now - r.windowStart)) / 1000)) };
  };
}

/** Caps simultaneous expensive operations (e.g. LLM generations). */
export function createConcurrencyGate(max) {
  let n = 0;
  return { tryEnter() { if (n >= max) return false; n++; return true; }, leave() { n = Math.max(0, n - 1); }, get active() { return n; } };
}

/**
 * Client IP. Behind a trusted proxy (Vercel, nginx) only the entry that the proxy itself appended is believable:
 * with TRUSTED_PROXY_HOPS=1 take the LAST X-Forwarded-For entry, with 2 the second-to-last, ... Without a trusted proxy the
 * header is attacker-controlled and ignored (otherwise anyone can dodge rate limits by sending a random X-Forwarded-For).
 */
export function clientIp(headers, socketAddr, trustedHops = 0) {
  const get = (n) => (typeof headers.get === "function" ? headers.get(n) : headers[n]);
  if (trustedHops > 0) {
    const xff = String(get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean);
    const ip = xff[xff.length - trustedHops] || get("x-real-ip");
    if (ip) return String(ip).slice(0, 64);
  }
  return String(socketAddr || "unknown").slice(0, 64);
}
