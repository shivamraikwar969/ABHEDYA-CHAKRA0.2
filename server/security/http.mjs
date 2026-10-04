// =====================================================================================
//  HTTP HARDENING helpers (headers, body reading with hard limits, slow-client protection)
// =====================================================================================
/** Headers for a JSON API. CSP default-src 'none': even if an API response were ever rendered, nothing may execute or load. */
export const API_SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload", // ignored over plain http, enforced behind TLS
};

/** Read a JSON body with a hard byte cap (checked on Content-Length AND while streaming) and a total time budget. */
export function readJson(req, { maxBytes = 64 * 1024, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => { reject(Object.assign(new Error(message), { status })); };
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return fail(415, "Content-Type must be application/json");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) { req.resume(); return fail(413, "body too large"); }
    let size = 0, done = false; const chunks = [];
    const timer = setTimeout(() => { if (!done) { done = true; fail(408, "request timed out"); req.destroy(); } }, timeoutMs);
    req.on("data", (c) => { if (done) return; size += c.length; if (size > maxBytes) { done = true; clearTimeout(timer); fail(413, "body too large"); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (done) return; done = true; clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { fail(400, "invalid JSON"); }
    });
    req.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

/** Slowloris / connection-exhaustion limits. */
export function hardenServer(server) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // whole-request cap (the narrate route itself waits on the model; it has its own timeout)
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 200;
}
