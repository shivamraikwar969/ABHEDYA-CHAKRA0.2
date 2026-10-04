// =====================================================================================
//  SCHEMA VALIDATION  (tiny, dependency-free, strict-by-default)
//
//  Every endpoint parses its body through a schema BEFORE any business logic runs:
//   * unknown keys are rejected (no mass-assignment), `__proto__` / `constructor` / `prototype` keys are rejected anywhere
//     (prototype pollution), nesting depth and array lengths are capped (payload overflow / stack-exhaustion DoS),
//   * strings are NFC-normalised, length-capped, and refuse NUL / control characters (log forging, truncation tricks),
//   * identifier-like fields use an allow-list pattern that cannot carry quotes, `;`, `|`, `&`, `$`, backticks, `<`, `>`,
//     `\`, braces or whitespace: so neither SQL meta-characters nor shell meta-characters can ride in on them.
//  The server never builds SQL or shell commands from request data; this is defence in depth, not the only layer.
// =====================================================================================
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // allows \t \n \r only when `multiline`
const CTRL_STRICT = /[\u0000-\u001f\u007f]/;

const ok = (value) => ({ ok: true, value });
const bad = (path, msg) => ({ ok: false, errors: [`${path || "body"}: ${msg}`] });

export const s = {
  string({ min = 0, max = 256, pattern, multiline = false, trim = true, lower = false } = {}) {
    return (v, path) => {
      if (typeof v !== "string") return bad(path, "must be a string");
      let x = v.normalize("NFC");
      if (trim) x = x.trim();
      if (lower) x = x.toLowerCase();
      if (x.length < min) return bad(path, `must be at least ${min} characters`);
      if (x.length > max) return bad(path, `must be at most ${max} characters`);
      if ((multiline ? CTRL : CTRL_STRICT).test(x)) return bad(path, "contains control characters");
      if (pattern && !pattern.test(x)) return bad(path, "has an invalid format");
      return ok(x);
    };
  },
  /** account numbers, IFSC codes, txn ids: letters, digits and . _ - : / @ # + only. */
  id({ max = 64 } = {}) { return s.string({ min: 1, max, pattern: /^[A-Za-z0-9._\-:/@#+]+$/ }); },
  username() { return s.string({ min: 3, max: 32, lower: true, pattern: /^[a-z0-9][a-z0-9._-]*$/ }); },
  email() { return s.string({ min: 5, max: 254, lower: true, pattern: /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/ }); },
  number({ min = -Infinity, max = Infinity, int = false } = {}) {
    return (v, path) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return bad(path, "must be a finite number");
      if (int && !Number.isInteger(v)) return bad(path, "must be an integer");
      if (v < min || v > max) return bad(path, `must be between ${min} and ${max}`);
      return ok(v);
    };
  },
  boolean() { return (v, path) => (typeof v === "boolean" ? ok(v) : bad(path, "must be a boolean")); },
  enum(values) { return (v, path) => (values.includes(v) ? ok(v) : bad(path, `must be one of ${values.join(", ")}`)); },
  array(item, { max = 1000, min = 0 } = {}) {
    return (v, path) => {
      if (!Array.isArray(v)) return bad(path, "must be an array");
      if (v.length > max) return bad(path, `must have at most ${max} items`);
      if (v.length < min) return bad(path, `must have at least ${min} items`);
      const out = [], errors = [];
      v.forEach((x, i) => { const r = item(x, `${path}[${i}]`); if (r.ok) out.push(r.value); else if (errors.length < 5) errors.push(...r.errors); });
      return errors.length ? { ok: false, errors } : ok(out);
    };
  },
  /** strict object: unknown keys are errors; `optional(...)` marks keys that may be absent. */
  object(shape) {
    return (v, path) => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return bad(path, "must be an object");
      const errors = [], out = Object.create(null);
      for (const k of Object.keys(v)) if (!(k in shape)) errors.push(`${path ? path + "." : ""}${String(k).slice(0, 40)}: unknown field`);
      for (const [k, sch] of Object.entries(shape)) {
        const p = path ? `${path}.${k}` : k;
        if (!Object.prototype.hasOwnProperty.call(v, k) || v[k] === undefined) { if (!sch.optional) errors.push(`${p}: is required`); continue; }
        const r = (sch.inner ?? sch)(v[k], p);
        if (r.ok) out[k] = r.value; else errors.push(...r.errors);
      }
      return errors.length ? { ok: false, errors: errors.slice(0, 8) } : ok({ ...out });
    };
  },
  optional(sch) { const f = (v, p) => sch(v, p); f.optional = true; f.inner = sch; return f; },
  /** opaque JSON sub-tree (e.g. the fact pack): depth / node-count bounded and prototype-pollution-safe; the existing guardrail sanitiser still runs on it. */
  json({ maxDepth = 8, maxNodes = 50_000 } = {}) {
    return (v, path) => {
      let nodes = 0;
      const walk = (x, d) => {
        if (d > maxDepth) return "nesting too deep";
        if (++nodes > maxNodes) return "too many values";
        if (Array.isArray(x)) { for (const y of x) { const e = walk(y, d + 1); if (e) return e; } }
        else if (x && typeof x === "object") { for (const k of Object.keys(x)) { if (BAD_KEYS.has(k)) return `forbidden key "${k}"`; const e = walk(x[k], d + 1); if (e) return e; } }
        else if (typeof x === "string" && x.length > 20_000) return "string too long";
        else if (typeof x === "number" && !Number.isFinite(x)) return "non-finite number";
        return null;
      };
      const e = walk(v, 0);
      return e ? bad(path, e) : ok(v);
    };
  },
};

/** Parse `value` with `schema`. Returns { ok:true, value } | { ok:false, errors:string[] }. Never throws. */
export function parse(schema, value) {
  try {
    // reject prototype-pollution keys anywhere before doing anything else
    const guard = (x, d = 0) => {
      if (d > 64) throw new RangeError("nesting too deep");
      if (Array.isArray(x)) x.forEach((y) => guard(y, d + 1));
      else if (x && typeof x === "object") for (const k of Object.keys(x)) { if (BAD_KEYS.has(k)) throw new RangeError(`forbidden key "${k}"`); guard(x[k], d + 1); }
    };
    guard(value);
    return schema(value, "");
  } catch (e) { return { ok: false, errors: [e instanceof RangeError ? e.message : "payload could not be validated"] }; }
}

// ---------- the request schemas used by the API ----------
const password = s.string({ min: 1, max: 128, trim: false });
export const schemas = {
  register: s.object({ username: s.username(), password, role: s.optional(s.enum(["analyst", "admin"])) }),
  login: s.object({ username: s.username(), password }),
  /** shared by /api/narrate and /api/dossier (the deep content checks stay in guardrail.validateRequest) */
  narrate: s.object({
    pack: s.json({ maxDepth: 8 }),
    allowedIds: s.array(s.id(), { max: 20_000 }),
    allowedAmounts: s.array(s.number({ min: 0, max: 1e13 }), { max: 20_000 }),
    officerNote: s.optional(s.string({ max: 4000, multiline: true, trim: false })),
  }),
  dossier: s.object({
    pack: s.json({ maxDepth: 8 }),
    allowedIds: s.array(s.id(), { max: 20_000 }),
    allowedAmounts: s.array(s.number({ min: 0, max: 1e13 }), { max: 20_000 }),
    officerNote: s.optional(s.string({ max: 4000, multiline: true, trim: false })),
    narrative: s.optional(s.string({ max: 20_000, multiline: true, trim: false })),
    format: s.optional(s.enum(["json", "markdown", "csv"])),
    meta: s.optional(s.object({ firNo: s.optional(s.string({ max: 120 })), policeStation: s.optional(s.string({ max: 120 })), investigatingOfficer: s.optional(s.string({ max: 120 })) })),
    store: s.optional(s.boolean()),
  }),
  verify: s.object({ dossier: s.json({ maxDepth: 8 }) }),
  vaultId: s.string({ min: 32, max: 32, pattern: /^[a-f0-9]{32}$/ }),
};
