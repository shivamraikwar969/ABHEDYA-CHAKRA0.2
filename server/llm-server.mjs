// =====================================================================================
//  RakshakAI - LOCAL LLM ENGINE (offline, no cloud, no npm dependencies)
//
//  A tiny HTTP service that sits between the browser UI and a model running ON THIS
//  MACHINE - either Ollama or llama.cpp's `llama-server`. All text the model produces
//  passes through the guardrail pipeline in guardrail.mjs before it can reach the UI.
//
//  Run:   node server/llm-server.mjs          (needs Node 18+)
//
//  Environment variables (all optional):
//    LLM_BACKEND   ollama | llamacpp          (default: ollama)
//    LLM_URL       model server address       (default: http://127.0.0.1:11434 for ollama,
//                                                       http://127.0.0.1:8080  for llamacpp)
//    LLM_MODEL     model name / tag           (default: llama3.2:3b)
//    PORT          this service's port        (default: 8787)
//    MAX_ATTEMPTS  regenerate tries           (default: 3)
//
//  Endpoints:
//    GET  /api/health   -> is the model server reachable, which model, which backend
//    POST /api/narrate  -> { pack, allowedIds, allowedAmounts, officerNote }
//                          returns { ok:true, text, ... }  or  { ok:false, fallback:true, reason, offline?, draft? }
//    POST /api/dossier  -> { pack, allowedIds, allowedAmounts, officerNote, narrative?, meta?, format? }
//                          compiles a tamper-evident case dossier (json | markdown | csv). Works with NO model running.
//    POST /api/dossier/verify -> { dossier }  re-computes the SHA-256 integrity digest
//
//  Hardening: strict request schema, origin + Host allow-list (ALLOWED_ORIGINS), rate limit, circuit breaker with
//  deterministic offline fallback, retry-with-backoff on transient model errors.
// =====================================================================================
import http from "node:http";
import { acceptable, buildMessages, deterministicNarrative, guardOutput, hostAllowed, makeAllowed, originAllowed, sanitizeUntrusted, validateRequest } from "./guardrail.mjs";
import { compileDossier, dossierToCsv, dossierToMarkdown, verifyDossier } from "./dossier.mjs";
import { AuthError, authenticate, login, logoutAll, me, register, userCount } from "./security/auth.mjs";
import { blindIndex } from "./security/crypto.mjs";
import { API_SECURITY_HEADERS, hardenServer, readJson } from "./security/http.mjs";
import { loadKeyRing } from "./security/keys.mjs";
import { passwordAlgorithm } from "./security/passwords.mjs";
import { TIERS, clientIp, createConcurrencyGate, createLimiter, storeFromEnv } from "./security/rateLimit.mjs";
import { parse, schemas } from "./security/schema.mjs";
import { vaultGet, vaultList, vaultPut } from "./security/vault.mjs";

const BACKEND = (process.env.LLM_BACKEND || "ollama").toLowerCase();
const LLM_URL = (process.env.LLM_URL || (BACKEND === "llamacpp" ? "http://127.0.0.1:8080" : "http://127.0.0.1:11434")).replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "llama3.2:3b";
const PORT = Number(process.env.PORT || 8787);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.MAX_ATTEMPTS || 3));
const MAX_BODY = 2_000_000; // bytes - a fact pack is only a few KB; anything larger is refused
// Origins allowed to call this service from a browser. "null" = the single-file build opened from disk. Override: ALLOWED_ORIGINS="http://localhost:*,null"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:*,http://127.0.0.1:*,null").split(",").map((x) => x.trim()).filter(Boolean);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "1"; // 1 = narrate/dossier need a Bearer token (vault + auth routes always do)
const TRUSTED_HOPS = Number(process.env.TRUSTED_PROXY_HOPS || 0); // >0 only when behind a proxy you control (Vercel/nginx)
if (process.env.RATE_PER_MIN) TIERS.global.max = Number(process.env.RATE_PER_MIN);
if (process.env.LLM_DAILY_BUDGET) TIERS.budget.max = Number(process.env.LLM_DAILY_BUDGET);
const limiter = createLimiter(storeFromEnv()); // Upstash Redis when UPSTASH_* is set, otherwise in-memory
const llmGate = createConcurrencyGate(Number(process.env.LLM_MAX_CONCURRENT || 2));
const BREAKER_FAILS = 3, BREAKER_COOLDOWN_MS = 30_000;

// ---------- resilience: circuit breaker for the model server (rate limiting lives in ./security/rateLimit.mjs) ----------
const breaker = { fails: 0, openUntil: 0 };
const breakerOpen = () => Date.now() < breaker.openUntil;
function breakerRecord(ok) {
  if (ok) { breaker.fails = 0; return; }
  if (++breaker.fails >= BREAKER_FAILS) { breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS; breaker.fails = 0; }
}
const TRANSIENT = new Set(["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "EAI_AGAIN"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One retry with backoff for transient socket errors only (never for ECONNREFUSED: the model server is simply off). */
async function generateResilient(messages) {
  try { return await generate(messages); }
  catch (e) {
    if (TRANSIENT.has(e?.cause?.code)) { await sleep(400); return await generate(messages); }
    throw e;
  }
}

// ---------- talk to the local model (L3: low temperature, fixed seed, capped length) ----------
async function generate(messages) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    if (BACKEND === "llamacpp") {
      // llama.cpp exposes an OpenAI-compatible endpoint
      const r = await fetch(`${LLM_URL}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, top_p: 0.9, max_tokens: 700, seed: 42, stream: false }),
      });
      if (!r.ok) throw new Error(`llama.cpp HTTP ${r.status}`);
      const j = await r.json();
      return j.choices?.[0]?.message?.content ?? "";
    }
    // default: Ollama
    const r = await fetch(`${LLM_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ model: MODEL, messages, stream: false, options: { temperature: 0.1, top_p: 0.9, seed: 42, num_predict: 700 } }),
    });
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
    const j = await r.json();
    return j.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  try {
    const url = BACKEND === "llamacpp" ? `${LLM_URL}/health` : `${LLM_URL}/api/tags`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { reachable: false, reason: `HTTP ${r.status}` };
    let models = [];
    if (BACKEND !== "llamacpp") { const j = await r.json(); models = (j.models || []).map((m) => m.name); }
    const modelPresent = BACKEND === "llamacpp" ? true : models.some((m) => m === MODEL || m.startsWith(MODEL + ":") || MODEL.startsWith(m));
    return { reachable: true, models, modelPresent };
  } catch (e) {
    return { reachable: false, reason: e?.cause?.code || e?.message || "unreachable" };
  }
}

// ---------- narrate: generate -> guard -> (retry with the violations named) -> fail closed ----------
async function narrate(input) {
  const v = validateRequest(input); // L0: strict schema + deep sanitisation
  if (!v.ok) return { ok: false, fallback: true, reason: "Request rejected: " + v.errors.slice(0, 3).join("; "), errors: v.errors };
  const { pack, allowedIds, allowedAmounts, officerNote } = v.value;
  const allowed = makeAllowed(allowedIds, allowedAmounts);
  const offline = (reason) => ({ ok: false, fallback: true, offline: true, reason, draft: deterministicNarrative(pack, allowed), backend: BACKEND, model: MODEL });
  if (breakerOpen()) return offline("Local model server unavailable (circuit open) - using the deterministic case diary.");
  const note = sanitizeUntrusted(officerNote, allowed); // L1
  let strict = "";
  const attemptsLog = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw;
    try { raw = await generateResilient(buildMessages(pack, note, strict)); breakerRecord(true); } // L2 + L3
    catch (e) {
      breakerRecord(false);
      return offline(e?.cause?.code === "ECONNREFUSED" ? "Local model server is not running." : `Model call failed: ${String(e?.name === "AbortError" ? "timeout" : e?.message || e).slice(0, 120)}`);
    }
    const g = guardOutput(raw, allowed); // L4 + L5
    attemptsLog.push({ attempt, sentences: g.totalSentences, removed: g.removed.length, violations: g.violations.slice(0, 8) });
    if (acceptable(g)) {
      return {
        ok: true, text: g.text, backend: BACKEND, model: MODEL, attempts: attempt, checked: g.checked,
        removedSentences: g.removed.length, removedExamples: g.removed.slice(0, 3), log: attemptsLog,
      };
    }
    // tell the model exactly what it got wrong and try again
    strict = g.violations.length
      ? `Your previous answer used values that are NOT in the facts (${[...new Set(g.violations)].slice(0, 6).join(", ")}). Use only values copied from the facts.`
      : "Your previous answer was too short or off-topic. Follow the OUTPUT format exactly.";
  }
  // L6: fail closed - nothing from the model is released
  return { ok: false, fallback: true, reason: "Model output could not be verified against the transaction graph; use the deterministic case diary.", draft: deterministicNarrative(pack, allowed), backend: BACKEND, model: MODEL, log: attemptsLog };
}

// ---------- dossier: compile + export (no model required) ----------
function dossier(input) {
  const v = validateRequest(input, { extraKeys: ["narrative", "meta", "format", "store"] });
  if (!v.ok) return { ok: false, fallback: true, reason: "Request rejected: " + v.errors.slice(0, 3).join("; "), errors: v.errors };
  const { pack, allowedIds, allowedAmounts, officerNote } = v.value;
  const format = ["json", "markdown", "csv"].includes(input.format) ? input.format : "json";
  const allowed = makeAllowed(allowedIds, allowedAmounts);
  // a supplied narrative (e.g. an earlier AI text) is re-verified here; if it does not pass it is simply not included
  let narrative = "";
  if (typeof input.narrative === "string" && input.narrative) { const g = guardOutput(input.narrative, allowed); if (acceptable(g)) narrative = g.text; }
  const meta = { generatedAt: new Date().toISOString(), generator: "RakshakAI dossier engine" };
  if (input.meta && typeof input.meta === "object") for (const k of ["firNo", "policeStation", "investigatingOfficer"]) if (typeof input.meta[k] === "string") meta[k] = sanitizeUntrusted(input.meta[k], allowed).slice(0, 120);
  const d = compileDossier({ pack, allowed, officerNote: sanitizeUntrusted(officerNote, allowed), narrative, meta });
  return { ok: true, format, dossier: d, content: format === "markdown" ? dossierToMarkdown(d) : format === "csv" ? dossierToCsv(pack) : undefined };
}

// ---------- HTTP layer: security headers, rate limits, auth, strict schemas ----------
const audit = (evt, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), evt, ...o })); // never log passwords, tokens or e-mails
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const ip = clientIp(req.headers, req.socket.remoteAddress, TRUSTED_HOPS);
  const send = (code, obj, extra = {}) => { res.writeHead(code, { ...API_SECURITY_HEADERS, ...extra }); res.end(JSON.stringify(obj)); };
  const deny = (code, reason, extra) => send(code, { ok: false, fallback: true, reason }, extra);
  const limited = (r) => deny(429, "Too many requests - slow down.", { "Retry-After": String(r.retryAfterSec), "RateLimit-Limit": String(r.limit), "RateLimit-Remaining": "0" });
  // DNS-rebinding + cross-site protection: only this machine's own pages may call the service
  if (!hostAllowed(req.headers.host)) return deny(403, "Host not allowed");
  if (!originAllowed(origin, ALLOWED_ORIGINS)) return deny(403, "Origin not allowed");
  if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") { res.writeHead(204, API_SECURITY_HEADERS); return res.end(); }
  let path;
  try { path = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "") || "/"; } catch { return deny(400, "bad request"); }
  try {
    // 1) whole-API budget per client IP (also covers GET /health, so it cannot be used to hammer the model probe)
    const g = await limiter("global", ip);
    if (!g.allowed) return limited(g);
    res.setHeader("RateLimit-Limit", String(g.limit)); res.setHeader("RateLimit-Remaining", String(g.remaining));

    if (req.method === "GET" && path === "/api/health") return send(200, { service: "rakshakai-llm", backend: BACKEND, model: MODEL, url: LLM_URL, breakerOpen: breakerOpen(), authRequired: REQUIRE_AUTH, ...(await health()) });

    // ----- authentication -----
    if (path.startsWith("/api/auth/")) {
      const a = await limiter("auth", ip);
      if (!a.allowed) { audit("auth.ratelimited", { ip }); return limited(a); }
      if (req.method === "GET" && path === "/api/auth/me") { const u = authenticate(req); return u ? send(200, { ok: true, user: me(u.id) }) : deny(401, "not signed in"); }
      if (req.method === "POST" && path === "/api/auth/logout") { const u = authenticate(req); if (u) { logoutAll(u.id); audit("auth.logout", { uid: u.id }); } return send(200, { ok: true }); }
      if (req.method === "POST" && path === "/api/auth/login") {
        const p = parse(schemas.login, await readJson(req, { maxBytes: 4096 }));
        if (!p.ok) return deny(400, "Request rejected: " + p.errors.slice(0, 3).join("; "));
        const acct = await limiter("authAccount", blindIndex(p.value.username, "ratelimit")); // distributed guessing against ONE account is capped regardless of source IP
        if (!acct.allowed) { audit("auth.account-ratelimited", { ip }); return limited(acct); }
        try { const r = await login(p.value); audit("auth.login", { ip, uid: r.user.id }); return send(200, { ok: true, ...r }); }
        catch (e) { if (e instanceof AuthError) { audit("auth.login-failed", { ip }); return deny(e.status, e.message, e.retryAfterSec ? { "Retry-After": String(e.retryAfterSec) } : {}); } throw e; }
      }
      if (req.method === "POST" && path === "/api/auth/register") {
        const p = parse(schemas.register, await readJson(req, { maxBytes: 4096 }));
        if (!p.ok) return deny(400, "Request rejected: " + p.errors.slice(0, 3).join("; "));
        try { const u = await register(p.value, authenticate(req)); audit("auth.register", { ip, uid: u.id, role: u.role }); return send(201, { ok: true, user: u }); }
        catch (e) { if (e instanceof AuthError) return deny(e.status, e.message); throw e; }
      }
      return send(404, { error: "not found" });
    }

    // ----- everything below needs a session when REQUIRE_AUTH=1 (vault: always) -----
    const user = authenticate(req);
    if ((REQUIRE_AUTH || path.startsWith("/api/vault")) && !user) return deny(401, "Authentication required", { "WWW-Authenticate": "Bearer" });

    if (req.method === "GET" && path === "/api/vault") return send(200, { ok: true, items: vaultList(user) });
    if (req.method === "GET" && path.startsWith("/api/vault/")) {
      const id = parse(schemas.vaultId, decodeURIComponent(path.slice("/api/vault/".length)));
      const item = id.ok && vaultGet(user, id.value);
      return item ? send(200, { ok: true, ...item }) : deny(404, "not found");
    }

    if (req.method === "POST") {
      const r = await limiter(path === "/api/narrate" ? "llm" : "heavy", ip);
      if (!r.allowed) return limited(r);
    }
    if (req.method === "POST" && path === "/api/narrate") {
      const p = parse(schemas.narrate, await readJson(req, { maxBytes: MAX_BODY }));
      if (!p.ok) return deny(400, "Request rejected: " + p.errors.slice(0, 3).join("; "));
      // Denial-of-Wallet guards: service-wide daily ceiling + cap on simultaneous generations (each can run for minutes)
      const b = await limiter("budget", "narrate");
      if (!b.allowed) { audit("llm.budget-exhausted"); return limited(b); }
      if (!llmGate.tryEnter()) return deny(503, "Model busy - try again shortly.", { "Retry-After": "5" });
      try { return send(200, await narrate(p.value)); } finally { llmGate.leave(); }
    }
    if (req.method === "POST" && path === "/api/dossier/verify") {
      const p = parse(schemas.verify, await readJson(req, { maxBytes: MAX_BODY }));
      if (!p.ok) return deny(400, "Request rejected: " + p.errors.slice(0, 3).join("; "));
      return send(200, { ok: true, intact: isObj(p.value.dossier) && verifyDossier(p.value.dossier) });
    }
    if (req.method === "POST" && path === "/api/dossier") {
      const p = parse(schemas.dossier, await readJson(req, { maxBytes: MAX_BODY }));
      if (!p.ok) return deny(400, "Request rejected: " + p.errors.slice(0, 3).join("; "));
      const out = dossier(p.value);
      if (out.ok && p.value.store) {
        if (!user) return deny(401, "Authentication required to store a dossier", { "WWW-Authenticate": "Bearer" });
        out.vault = vaultPut(user.id, out.dossier); // encrypted at rest (AES-256-GCM)
        audit("vault.put", { uid: user.id, id: out.vault.id });
      }
      return send(200, out);
    }
    send(404, { error: "not found" });
  } catch (e) {
    // same {ok:false, fallback:true} shape the UI already handles; internal error text is never echoed to the client
    const client = e?.status && e.status >= 400 && e.status < 500;
    if (!client) audit("error", { path, name: e?.name, code: e?.cause?.code || e?.code || e?.status });
    const reason = client ? String(e.message).slice(0, 200) : e?.cause?.code === "ECONNREFUSED" ? "Local model server is not running." : e?.status === 503 ? "Server busy - try again shortly." : "Request could not be processed.";
    send(client || e?.status === 503 ? e.status : 200, { ok: false, fallback: true, reason }, e?.status === 503 ? { "Retry-After": "5" } : {});
  }
});
hardenServer(server);

// fail closed on misconfiguration BEFORE listening
loadKeyRing(); // throws if production has no RAKSHAK_KEYS
if (process.env.NODE_ENV === "production" && !REQUIRE_AUTH) throw new Error("NODE_ENV=production requires REQUIRE_AUTH=1");
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`security: password hash=${await passwordAlgorithm()} | auth ${REQUIRE_AUTH ? "REQUIRED" : "optional (set REQUIRE_AUTH=1)"} | users=${userCount()} | rate-limit store=${process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory"}`);
  console.log(`RakshakAI local LLM service on http://127.0.0.1:${PORT}  ->  ${BACKEND} @ ${LLM_URL}  model=${MODEL}`);
});
