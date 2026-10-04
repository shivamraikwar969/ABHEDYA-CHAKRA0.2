/**
 * Vercel Edge Middleware - runs BEFORE any serverless function, so abusive traffic is rejected at the edge and never bills
 * function time (Denial-of-Wallet protection). Only /api/* is matched; the static SPA is untouched.
 *
 * Shared counters: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in the Vercel project (Upstash integration) so every
 * edge instance sees the same budget. Without them the limiter is per-instance (still useful, but weaker).
 */
import { clientIp, createLimiter, storeFromEnv } from "./server/security/rateLimit.mjs";

export const config = { matcher: ["/api/:path*"] };

const limiter = createLimiter(storeFromEnv());
const MAX_BODY = 2_000_000;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });

export default async function middleware(request: Request): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(request.method)) return json(405, { ok: false, reason: "Method not allowed" }, { Allow: "GET, HEAD, POST, OPTIONS" });
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return json(413, { ok: false, reason: "Body too large" });
  if (request.method === "POST" && !/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json(415, { ok: false, reason: "Content-Type must be application/json" });

  const ip = clientIp(request.headers, "unknown", 1); // Vercel appends the real client IP; 1 trusted hop
  const tier = pathname.startsWith("/api/auth") ? "auth" : pathname.startsWith("/api/narrate") ? "llm" : request.method === "POST" ? "heavy" : "global";
  for (const t of tier === "global" ? ["global"] : ["global", tier]) {
    const r = await limiter(t, ip);
    if (!r.allowed) return json(429, { ok: false, fallback: true, reason: "Too many requests - slow down." }, { "Retry-After": String(r.retryAfterSec), "RateLimit-Limit": String(r.limit), "RateLimit-Remaining": "0" });
  }
  if (tier === "llm") { // service-wide daily ceiling on the expensive route, regardless of how many IPs the attacker rotates through
    const b = await limiter("budget", "narrate");
    if (!b.allowed) return json(429, { ok: false, fallback: true, reason: "Daily capacity reached." }, { "Retry-After": String(b.retryAfterSec) });
  }
  return undefined; // continue to the API route
}

