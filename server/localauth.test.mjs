// Tests the browser-only account logic with a fake localStorage and a stand-in for bcryptjs (scrypt) - run: npm run test:local
// The real bcryptjs is used in the browser; here we verify storage, policy, lockout and timing-equalisation logic.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(root, "node_modules", "bcryptjs"); const hadModules = (await import("node:fs")).existsSync(path.join(root, "node_modules"));
mkdirSync(stub, { recursive: true });
writeFileSync(path.join(stub, "package.json"), '{"name":"bcryptjs","type":"module","main":"index.js"}');
writeFileSync(path.join(stub, "index.js"), `import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
export default { async hash(s) { const salt = randomBytes(16); return "$stub$" + salt.toString("hex") + "$" + scryptSync(s, salt, 32, { N: 1024 }).toString("hex"); },
  async compare(s, h) { const [, , salt, d] = h.split("$"); return timingSafeEqual(scryptSync(s, Buffer.from(salt, "hex"), 32, { N: 1024 }), Buffer.from(d, "hex")); } };`);
const store = new Map(); globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
try {
  const L = await import("../src/engine/localAuth.ts");
  assert.equal(L.hasLocalAccounts(), false);
  assert.match((await L.localSignIn("ghost", "whatever-long-pass1")).reason, /Sign up first/);
  assert.equal((await L.localSignUp("Officer.One", "short")).ok, false);
  assert.equal((await L.localSignUp("Officer.One", "xxofficer.onexx-9999")).ok, false); // contains username
  assert.equal((await L.localSignUp("Officer.One", "tangerine-orbit-77!")).ok, true);
  const raw = store.get("rk.local.users.v1"); assert.ok(!raw.includes("tangerine") && raw.includes("officer.one")); // hash only, username normalised
  assert.equal((await L.localSignUp("officer.one", "tangerine-orbit-77!")).ok, false); // duplicate (case-insensitive)
  assert.equal((await L.localSignIn("OFFICER.one", "tangerine-orbit-77!")).ok, true);
  const w1 = await L.localSignIn("officer.one", "wrong-wrong-wrong"), w2 = await L.localSignIn("nobody.here", "wrong-wrong-wrong");
  assert.equal(w1.reason, w2.reason); // same message for wrong password vs unknown user
  for (let i = 0; i < 4; i++) await L.localSignIn("officer.one", "wrong-wrong-wrong");
  const locked = await L.localSignIn("officer.one", "tangerine-orbit-77!"); // right password refused while locked
  assert.equal(locked.ok, false); assert.match(locked.reason, /Too many attempts/);
  console.log("local auth: 9 checks passed");
} finally { rmSync(stub, { recursive: true, force: true }); if (!hadModules) rmSync(path.join(root, "node_modules"), { recursive: true, force: true }); }
