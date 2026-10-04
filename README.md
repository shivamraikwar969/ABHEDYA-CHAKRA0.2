# RakshakAI  (Operation Abhedya-Chakra · codename SETU)

Offline cyber-fraud forensics: ingest a transaction CSV, score mule accounts, trace victim money 4 hops,
replay the flow, isolate rings, and draft case documents - all on your own machine.

## Run the app
```bash
npm install
npm run dev          # http://localhost:5173
```

## What was added in this version (nothing was removed)
| Area | What you get |
|---|---|
| **Ground-Truth Calibration** (sidebar -> *Ground-Truth Calibration*) | Load the organisers' answer key (e.g. 1,500 mules vs 23,500 normal). Live confusion matrix, precision / recall / F1, ROC-AUC, threshold sweep and an auto weight-tuner trained on 70% and reported on the unseen 30%. Nothing is pre-filled - numbers come only from the file you load. |
| **Local LLM engine** (*AI Case Officer* -> *Local AI narrator*) | `server/llm-server.mjs` binds to **Ollama** or **llama.cpp** on this machine. 6 guardrail layers (see `server/guardrail.mjs`); every account / IFSC / txn-ID / rupee amount in model text must exist in the graph or the sentence is dropped; if too much is dropped the model text is withheld (fail-closed) and the deterministic diary is used. The browser re-verifies again. |
| **Beginner-friendly hierarchy** | Wider spacing, labelled levels (Victim -> Collectors -> Distributors -> Indicators -> Final stop), role tags on every node, and a collapsible plain-language glossary. |
| **Where did the money go?** | Leaf accounts show exit tags - CRYPTO / ATM / WALLET / GIFT / CARD / ONWARD / PARKED - on the graph, in a summary panel, and in the case diary (section 3A). In *Flow Playback* it updates as the playback cursor moves. |

## Start the local LLM (optional, fully offline)
```bash
# Option A - Ollama
ollama pull llama3.2:3b
npm run llm                              # starts http://127.0.0.1:8787

# Option B - llama.cpp
llama-server -m your-model.gguf --port 8080
LLM_BACKEND=llamacpp npm run llm

# test the guardrails (no model needed)
npm run test:guardrail
```
Env vars: `LLM_BACKEND`, `LLM_URL`, `LLM_MODEL`, `PORT`, `MAX_ATTEMPTS` (see top of `server/llm-server.mjs`).

## Security hardening (enterprise profile)
UI, CSS, Tailwind classes and animations are unchanged - all 9 views are byte-identical except `CaseView.tsx` (text now passes through `cleanText`).

| Layer | Where | What |
|---|---|---|
| Password hashing | `server/security/passwords.mjs` | Argon2id (64 MiB, t=3, p=4, random 16-byte salt per user) + server-side HMAC pepper; scrypt N=2^17 fallback only if `argon2` is missing (`REQUIRE_ARGON2=1` forbids it); auto-rehash on login; bounded hashing concurrency |
| Encryption at rest | `server/security/crypto.mjs`, `vault.mjs`, `auth.mjs` | AES-256-GCM, per-message HKDF key + random IV, context-bound AAD, key-ring rotation (`RAKSHAK_KEYS`); user e-mail/name/hash and stored dossiers are ciphertext on disk; e-mail lookup via HMAC blind index |
| Auth | `server/security/auth.mjs` | Signed, revocable, short-lived Bearer sessions; lockout with back-off; first user = admin, then admin-only registration; no account enumeration |
| Brute force / DoW | `server/security/rateLimit.mjs`, `middleware.ts` | Sliding-window limits per IP, per account, per route class; daily LLM budget; concurrency cap; Upstash Redis shared counters; Vercel Edge middleware on `/api/*`; XFF only trusted via `TRUSTED_PROXY_HOPS` |
| Input validation | `server/security/schema.mjs` | Strict schemas on every endpoint: unknown keys, prototype-pollution keys, control chars, depth/length caps; IDs limited to `A-Za-z0-9._-:/@#+` (no SQL/shell metacharacters); body size + time limits |
| SQL console | `src/utils/sqlGuard.ts` | Single read-only statement; blocks COPY/ATTACH/INSTALL/SET/DDL/DML, file & URL readers |
| XSS | `src/utils/sanitize.ts` (DOMPurify), `vercel.json` | Untrusted text (officer inputs, AI output, report lines) reduced to inert text; CSV formula-injection guard; hash-pinned CSP |

Setup
```bash
npm install                      # installs dompurify + argon2 (optional dep) and refreshes package-lock.json
cp .env.example .env             # set RAKSHAK_KEYS, REQUIRE_AUTH=1, ...
npm test                         # guardrail + 34 security checks + SQL-guard checks
npm run build                    # postbuild pins the inline-script/style SHA-256 hashes into vercel.json
git add vercel.json              # Vercel reads headers from the COMMITTED file; commit after every bundle change
npm run csp:check                # CI gate: fails if script-src is not hash-pinned or is stale
```
API (default `http://127.0.0.1:8787`): `POST /api/auth/register|login|logout`, `GET /api/auth/me`, `POST /api/narrate|dossier|dossier/verify`
(`dossier` with `"store": true` saves it AES-encrypted), `GET /api/vault`, `GET /api/vault/:id`.

### Login page
The dashboard now opens only after Login / Sign up (`src/components/LoginPage.tsx`, `AuthGate.tsx`). Identity is **username + password**.
`npm start` runs the auth/API service (8787) and the Vite app (5173) together. The first account created becomes admin.
Sign-up is open in development; in production it is closed unless `ALLOW_OPEN_SIGNUP=1` (otherwise an admin creates accounts).
The session token is held in memory only, so reloading the tab signs you out.

### Offline (browser-only) accounts
If the auth service is not reachable, the login page switches to **offline mode** automatically (badge on the page): the password is
SHA-256 pre-hashed then **bcrypt cost 12** (`src/engine/localAuth.ts`, `bcryptjs`), with lockout after 5 failures; only the hash is stored in this
browser. A reachable server that rejects a login is final - there is no fallback then. Offline mode is a convenience gate, not a security boundary
(DevTools can edit localStorage); use the server with `REQUIRE_AUTH=1` for real enforcement.
