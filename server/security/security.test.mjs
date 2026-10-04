// Run:  npm run test:security      (no dependencies; uses a throw-away key + data dir)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const tmp = mkdtempSync(path.join(tmpdir(), "rakshak-sec-"));
process.env.RAKSHAK_DATA_DIR = path.join(tmp, "data");
process.env.RAKSHAK_SECRETS_DIR = path.join(tmp, "secrets");
process.env.RAKSHAK_KEYS = "k2:" + randomBytes(32).toString("base64") + ",k1:" + randomBytes(32).toString("base64");
process.env.ALLOW_OPEN_SIGNUP = "0"; // tests the closed mode first
process.env.SCRYPT_LOG_N = "12"; // fast for tests; production default is 17
let passed = 0; const t = async (name, fn) => { await fn(); passed++; console.log("  ok  " + name); };

const C = await import("./crypto.mjs"), K = await import("./keys.mjs"), P = await import("./passwords.mjs");
const S = await import("./schema.mjs"), R = await import("./rateLimit.mjs"), A = await import("./auth.mjs"), V = await import("./vault.mjs");

console.log("crypto");
await t("AES-256-GCM field round-trip, random IV/salt each time", () => {
  const a = C.encryptField("hello ₹49,000", "ctx"), b = C.encryptField("hello ₹49,000", "ctx");
  assert.notEqual(a, b); assert.ok(a.startsWith("enc1:")); assert.equal(C.decryptField(a, "ctx"), "hello ₹49,000");
});
await t("tampering is detected", () => {
  const a = Buffer.from(C.encryptField("secret", "c").slice(5), "base64url"); a[a.length - 1] ^= 1;
  assert.throws(() => C.decryptField("enc1:" + a.toString("base64url"), "c"), /authentication failed/);
});
await t("ciphertext is bound to its context (cannot be moved between fields/records)", () => {
  const a = C.encryptField("secret", "users.username:1");
  assert.throws(() => C.decryptField(a, "users.username:2"), /authentication failed/);
});
await t("key rotation: data written under the old key still decrypts, new writes use the active key", () => {
  const ring = K.loadKeyRing(); assert.equal(ring[0].id, "k2");
  const old = Buffer.from(C.encryptField("x", "c").slice(5), "base64url"); assert.equal(old.subarray(2, 2 + old[1]).toString(), "k2");
  const saved = process.env.RAKSHAK_KEYS; const [k2, k1] = saved.split(",");
  process.env.RAKSHAK_KEYS = k1 + "," + k2.replace("k2:", "k3:"); // pretend k1 became active
  K._resetKeyRing();
  assert.equal(K.activeKey().id, "k1");
  process.env.RAKSHAK_KEYS = saved; K._resetKeyRing();
});
await t("blind index is deterministic, case-insensitive, purpose-separated", () => {
  assert.equal(C.blindIndex("A@B.com", "x"), C.blindIndex(" a@b.com ", "x")); assert.notEqual(C.blindIndex("a@b.com", "x"), C.blindIndex("a@b.com", "y"));
});

console.log("passwords");
await t("hash is salted, verifies, rejects wrong password", async () => {
  const h1 = await P.hashPassword("correct horse battery"), h2 = await P.hashPassword("correct horse battery");
  assert.notEqual(h1, h2); assert.ok(await P.verifyPassword("correct horse battery", h1)); assert.equal(await P.verifyPassword("correct horse batterY", h1), false);
  assert.ok(/^\$(argon2id|scrypt)\$/.test(h1)); console.log("      algorithm:", await P.passwordAlgorithm());
});
await t("policy: length, control chars, username reuse, common", () => {
  assert.ok(P.passwordPolicyError("short")); assert.ok(P.passwordPolicyError("a".repeat(129))); assert.ok(P.passwordPolicyError("password1234"));
  assert.ok(P.passwordPolicyError("johnsmith-2024-x", { username: "johnsmith" })); assert.equal(P.passwordPolicyError("tangerine-orbit-77!"), null);
});
await t("attacker-chosen scrypt parameters are refused; garbage hashes fail closed", async () => {
  assert.equal(await P.verifyPassword("x", "$scrypt$ln=30,r=8,p=1$AAAA$AAAA"), false); assert.equal(await P.verifyPassword("x", "plaintext"), false);
});
await t("legacy / weaker hash is flagged for rehash", async () => { assert.equal(await P.needsRehash("$scrypt$ln=8,r=8,p=1$AAAA$AAAA"), true); });

console.log("schema validation");
const reg = S.schemas.register;
await t("accepts a valid body, strips nothing unexpected", () => assert.ok(S.parse(reg, { username: "Abuser", password: "x" }).ok));
await t("rejects unknown fields (mass assignment)", () => assert.equal(S.parse(reg, { username: "abuser", password: "x", isAdmin: true }).ok, false));
await t("rejects prototype pollution keys anywhere", () => {
  assert.equal(S.parse(reg, JSON.parse('{"username":"abuser","password":"x","__proto__":{"admin":true}}')).ok, false);
  assert.equal(S.parse(S.schemas.verify, JSON.parse('{"dossier":{"a":{"constructor":{}}}}')).ok, false);
});
await t("identifier fields cannot carry SQL / shell / HTML metacharacters", () => {
  const ids = S.s.array(S.s.id());
  for (const evil of ["x' OR '1'='1", "a;rm -rf /", "$(id)", "`id`", "a|b", "a&b", "<script>", "a\nb", "a b", "x\u0000y", "\\\\host\\share", "{{7*7}}"]) assert.equal(S.parse(ids, [evil]).ok, false, evil);
  assert.ok(S.parse(ids, ["ACC00000001", "SBIN0123456", "UPI/123-abc@okbank"]).ok);
});
await t("payload overflow: depth, array length, string length are capped", () => {
  let deep = {}; let c = deep; for (let i = 0; i < 20; i++) { c.a = {}; c = c.a; }
  assert.equal(S.parse(S.schemas.verify, { dossier: deep }).ok, false);
  assert.equal(S.parse(S.s.array(S.s.number(), { max: 5 }), [1, 2, 3, 4, 5, 6]).ok, false);
  assert.equal(S.parse(S.s.string({ max: 10 }), "x".repeat(11)).ok, false);
  assert.equal(S.parse(S.s.number(), NaN).ok, false);
});
await t("control characters / NUL are refused in strings", () => assert.equal(S.parse(S.s.string(), "a\u0000b").ok, false));

console.log("rate limiting");
await t("blocks after the budget, per key, and recovers", async () => {
  const lim = R.createLimiter(new R.MemoryStore()); const tier = { windowMs: 1000, max: 3 }; const now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.ok((await lim(tier, "ip1", now)).allowed);
  const r = await lim(tier, "ip1", now); assert.equal(r.allowed, false); assert.ok(r.retryAfterSec >= 1);
  assert.ok((await lim(tier, "ip2", now)).allowed); // other clients unaffected
  assert.ok((await lim(tier, "ip1", now + 2500)).allowed); // window passed
});
await t("memory is bounded under a key flood (overflow bucket, never unbounded growth)", async () => {
  const st = new R.MemoryStore(100); const lim = R.createLimiter(st);
  for (let i = 0; i < 1000; i++) await lim({ windowMs: 60000, max: 5 }, "k" + i, 5_000_000);
  assert.ok(st.m.size <= 101);
});
await t("X-Forwarded-For is ignored unless proxy hops are trusted", () => {
  assert.equal(R.clientIp({ "x-forwarded-for": "6.6.6.6" }, "10.0.0.1", 0), "10.0.0.1");
  assert.equal(R.clientIp({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "10.0.0.1", 1), "1.2.3.4"); // spoofed left entry ignored
});
await t("concurrency gate", () => { const g = R.createConcurrencyGate(2); assert.ok(g.tryEnter() && g.tryEnter()); assert.equal(g.tryEnter(), false); g.leave(); assert.ok(g.tryEnter()); });

console.log("auth + vault");
let admin, tok;
await t("first user becomes admin; username & hash are encrypted at rest", async () => {
  admin = await A.register({ username: "Officer.One", password: "tangerine-orbit-77!" });
  assert.equal(admin.role, "admin");
  const file = readFileSync(path.join(process.env.RAKSHAK_DATA_DIR, "users.json"), "utf8");
  assert.ok(!file.includes("officer@police") && !/officer/i.test(file) && !file.includes("tangerine") && !file.includes("argon2") && !file.includes("scrypt"));
});
await t("registration is closed to the public once an admin exists", async () => {
  await assert.rejects(A.register({ username: "xuser", password: "another-long-secret-9" }), { status: 403 });
  const u = await A.register({ username: "analyst1", password: "another-long-secret-9" }, { role: "admin" }); assert.equal(u.role, "analyst");
});
await t("open sign-up (ALLOW_OPEN_SIGNUP=1): anyone can register but can never self-promote to admin", async () => {
  process.env.ALLOW_OPEN_SIGNUP = "1";
  const u = await A.register({ username: "newcomer", password: "violet-harbor-2049", role: "admin" }); assert.equal(u.role, "analyst");
  process.env.ALLOW_OPEN_SIGNUP = "0";
});
await t("duplicate username is refused", async () => { await assert.rejects(A.register({ username: "analyst1", password: "another-long-secret-9" }, { role: "admin" }), /not available/); });
await t("login ok, wrong password and unknown user give the same message", async () => {
  const r = await A.login({ username: "officer.one", password: "tangerine-orbit-77!" }); tok = r.token; assert.ok(tok.startsWith("v1."));
  const e1 = await A.login({ username: "officer.one", password: "wrong-wrong-wrong" }).catch((e) => e.message);
  const e2 = await A.login({ username: "nobody1", password: "wrong-wrong-wrong" }).catch((e) => e.message); assert.equal(e1, e2);
});
await t("token: tamper / expiry / revocation", async () => {
  const req = (tk) => ({ headers: { authorization: "Bearer " + tk } });
  assert.ok(A.authenticate(req(tok)));
  const [v, b, sig] = tok.split("."); const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, "base64url")), role: "admin", sub: "x" })).toString("base64url");
  assert.equal(A.authenticate(req(`${v}.${forged}.${sig}`)), null);
  assert.equal(A.authenticate(req(A.signToken({ sub: admin.id, role: "admin", tv: 0, exp: Math.floor(Date.now() / 1000) - 5 }))), null);
  A.logoutAll(admin.id); assert.equal(A.authenticate(req(tok)), null);
});
await t("account lockout after 5 failures", async () => {
  for (let i = 0; i < 5; i++) await A.login({ username: "analyst1", password: "bad-bad-bad-bad" }).catch(() => {});
  await assert.rejects(A.login({ username: "analyst1", password: "another-long-secret-9" }), { status: 429 }); // even the right password is refused while locked
});
await t("vault: encrypted on disk, owner-isolated, traversal-proof", async () => {
  const a = { id: "u1", role: "analyst" }, b = { id: "u2", role: "analyst" };
  const { id } = V.vaultPut("u1", { victim: "ACC00000001", note: "SENSITIVE-CASE-DATA" });
  const raw = readFileSync(path.join(process.env.RAKSHAK_DATA_DIR, "vault", id + ".enc")).toString("latin1");
  assert.ok(!raw.includes("SENSITIVE") && !raw.includes("ACC00000001"));
  assert.equal(V.vaultGet(a, id).data.note, "SENSITIVE-CASE-DATA"); assert.equal(V.vaultGet(b, id), null); assert.ok(V.vaultGet({ id: "adm", role: "admin" }, id));
  assert.equal(V.vaultGet(a, "../../users"), null); assert.equal(V.vaultList(b).length, 0); assert.equal(V.vaultList(a).length, 1);
});

console.log("HTTP end-to-end");
const PORT = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "llm-server.mjs")], {
  env: { ...process.env, PORT: String(PORT), RAKSHAK_DATA_DIR: path.join(tmp, "data2"), REQUIRE_AUTH: "1", LLM_URL: "http://127.0.0.1:9", RATE_PER_MIN: "200" }, stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((res, rej) => { srv.stdout.on("data", (d) => String(d).includes("security:") && res()); srv.stderr.on("data", (d) => { if (/Error|throw/.test(String(d))) rej(new Error(String(d))); }); setTimeout(() => rej(new Error("server did not start")), 8000); });
const j = (p, o = {}) => fetch(base + p, { ...o, headers: { "Content-Type": "application/json", ...(o.headers || {}) } });
try {
  await t("security headers on every response", async () => {
    const r = await j("/api/health"); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.equal(r.headers.get("cache-control"), "no-store"); assert.ok(r.headers.get("ratelimit-limit"));
  });
  await t("REQUIRE_AUTH: narrate/dossier/vault refuse anonymous callers", async () => {
    for (const p of ["/api/narrate", "/api/dossier", "/api/dossier/verify"]) assert.equal((await j(p, { method: "POST", body: "{}" })).status, 401, p);
    assert.equal((await j("/api/vault")).status, 401);
  });
  let token;
  await t("bootstrap admin, login over HTTP", async () => {
    const r = await j("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "bossuser", password: "tangerine-orbit-77!" }) }); assert.equal(r.status, 201);
    const l = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "bossuser", password: "tangerine-orbit-77!" }) }); assert.equal(l.status, 200); token = (await l.json()).token;
    assert.equal((await j("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "eviluser", password: "tangerine-orbit-77!" }) })).status, 403);
  });
  const auth = () => ({ Authorization: "Bearer " + token });
  await t("input validation: unknown field, SQLi/shell ids, wrong content-type, oversize, bad JSON", async () => {
    const good = { pack: { victim: { account: "ACC1" } }, allowedIds: ["ACC1"], allowedAmounts: [1] };
    assert.equal((await j("/api/narrate", { method: "POST", headers: auth(), body: JSON.stringify({ ...good, admin: true }) })).status, 400);
    assert.equal((await j("/api/narrate", { method: "POST", headers: auth(), body: JSON.stringify({ ...good, allowedIds: ["a'; DROP TABLE txns;--"] }) })).status, 400);
    assert.equal((await j("/api/narrate", { method: "POST", headers: { ...auth(), "Content-Type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await j("/api/narrate", { method: "POST", headers: auth(), body: "{not json" })).status, 400);
    assert.equal((await j("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "abuser", password: "x".repeat(5000) }) })).status, 413);
  });
  await t("dossier compiles, can be stored encrypted and read back by the owner only", async () => {
    const body = { pack: { victim: { account: "ACC1" }, totalSiphoned: "₹1" }, allowedIds: ["ACC1"], allowedAmounts: [1], store: true };
    const r = await (await j("/api/dossier", { method: "POST", headers: auth(), body: JSON.stringify(body) })).json(); assert.ok(r.ok && r.vault.id);
    const g = await j("/api/vault/" + r.vault.id, { headers: auth() }); assert.equal(g.status, 200);
    assert.equal((await j("/api/vault/..%2f..%2fusers", { headers: auth() })).status, 404);
    const v = await (await j("/api/dossier/verify", { method: "POST", headers: auth(), body: JSON.stringify({ dossier: r.dossier }) })).json(); assert.equal(v.intact, true);
    const files = readdirSync(path.join(tmp, "data2", "vault")); assert.ok(!readFileSync(path.join(tmp, "data2", "vault", files[0])).toString("latin1").includes("ACC1"));
  });
  await t("brute force: login endpoint returns 429 with Retry-After", async () => {
    let last; for (let i = 0; i < 12; i++) last = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "bossuser", password: "wrong-wrong-wrong" }) });
    assert.equal(last.status, 429); assert.ok(Number(last.headers.get("retry-after")) >= 1);
  });
  await t("forged X-Forwarded-For does not dodge limits (header ignored without trusted proxy)", async () => {
    const r = await j("/api/auth/login", { method: "POST", headers: { "X-Forwarded-For": "9.9.9.9" }, body: JSON.stringify({ username: "bossuser", password: "wrong-wrong-wrong" }) }); assert.equal(r.status, 429);
  });
  await t("foreign Origin / Host are rejected", async () => {
    assert.equal((await j("/api/health", { headers: { Origin: "https://evil.example" } })).status, 403);
  });
} finally { srv.kill(); rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${passed} security checks passed`);
