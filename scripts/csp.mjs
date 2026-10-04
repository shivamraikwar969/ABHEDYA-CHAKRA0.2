// =====================================================================================
//  Builds the Content-Security-Policy for vercel.json from the REAL build output.
//
//  The app ships as a single HTML file (vite-plugin-singlefile): its JS and CSS are inline. Rather than allowing
//  'unsafe-inline' (which would defeat the whole point of a CSP), every inline <script>/<style> is pinned by its SHA-256 hash,
//  so only the exact code we built can run - an injected <script> or javascript: URL is blocked by the browser.
//
//    npm run build        -> runs this automatically (postbuild) and rewrites vercel.json
//    npm run csp:check    -> exit 1 if vercel.json is stale or still allows inline scripts (use in CI / before deploy)
//
//  IMPORTANT: Vercel reads headers from the vercel.json COMMITTED in git, so commit it after every build that changes the bundle.
//  Extra connect-src origins (e.g. your hosted LLM API):  CSP_CONNECT_EXTRA="https://llm.example.com" npm run build
// =====================================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = path.join(ROOT, "dist", "index.html"), VERCEL = path.join(ROOT, "vercel.json");
const CHECK = process.argv.includes("--check");

const hash = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";
export function inlineBlocks(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  for (const m of html.matchAll(re)) if (!/\bsrc\s*=/i.test(m[1]) && m[2].trim() !== "" && !/type\s*=\s*["']?(application\/(ld\+)?json|importmap)/i.test(m[1])) out.push(m[2]);
  return out;
}
const unique = (a) => [...new Set(a)];

export function buildCsp(html, extraConnect = (process.env.CSP_CONNECT_EXTRA || "").split(/\s+/).filter(Boolean)) {
  const scripts = unique(inlineBlocks(html, "script").map(hash)), styles = unique(inlineBlocks(html, "style").map(hash));
  if (!scripts.length && /<script/i.test(html) === false) throw new Error("no <script> found in dist/index.html - is this the right build?");
  return [
    "default-src 'none'",
    // 'wasm-unsafe-eval' = compile WebAssembly only (DuckDB-WASM). It does NOT permit eval()/new Function().
    `script-src ${[...scripts, "'wasm-unsafe-eval'", "https://cdn.jsdelivr.net"].join(" ")}`,
    `style-src ${["'self'", ...styles, "https://fonts.googleapis.com"].join(" ")}`,
    `style-src-elem ${["'self'", ...styles, "https://fonts.googleapis.com"].join(" ")}`,
    "style-src-attr 'unsafe-inline'", // React style={{...}} attributes (charts, bars). Attribute styles cannot execute script; kept so the UI renders identically.
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", "https://cdn.jsdelivr.net", "http://127.0.0.1:8787", "http://localhost:8787", ...extraConnect].join(" ")}`,
    "worker-src blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "manifest-src 'self'",
  ].join("; ");
}

const HEADERS = (csp) => [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = JSON.parse(readFileSync(VERCEL, "utf8"));
  const current = cfg.headers?.find((h) => h.source === "/(.*)")?.headers?.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  if (CHECK) {
    const scriptSrc = /script-src ([^;]*)/.exec(current)?.[1] ?? "";
    if (/'unsafe-inline'/.test(scriptSrc) || !/'sha256-/.test(scriptSrc)) { console.error("CSP check FAILED: script-src is not hash-pinned. Run `npm run build` and commit vercel.json."); process.exit(1); }
    if (existsSync(HTML)) { const want = buildCsp(readFileSync(HTML, "utf8")); if (want !== current) { console.error("CSP check FAILED: vercel.json does not match dist/index.html. Run `npm run build` and commit vercel.json."); process.exit(1); } }
    console.log("CSP check passed."); process.exit(0);
  }
  if (!existsSync(HTML)) { console.error("dist/index.html not found - run `vite build` first."); process.exit(1); }
  const csp = buildCsp(readFileSync(HTML, "utf8"));
  cfg.headers = [{ source: "/(.*)", headers: HEADERS(csp) }, ...(cfg.headers ?? []).filter((h) => h.source !== "/(.*)")];
  writeFileSync(VERCEL, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`vercel.json updated: ${(csp.match(/'sha256-/g) || []).length} inline hash(es) pinned, no 'unsafe-inline' in script-src.`);
}
