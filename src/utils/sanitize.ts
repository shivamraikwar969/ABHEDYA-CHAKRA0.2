import DOMPurify from "dompurify";

/**
 * XSS defence for every piece of text that is typed by a person, produced by a model, or injected into a report.
 *
 * The app renders through React text nodes (escaped by construction) and has no dangerouslySetInnerHTML. DOMPurify is the
 * second, independent layer: anything that could ever be parsed as markup is reduced to its inert text before it is shown,
 * copied, printed or sent to another service. Raw forensic evidence (the ingested CSV rows) is NOT rewritten - it is only
 * ever displayed as a text node, so the evidentiary record stays byte-exact.
 */

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g; // control + zero-width + bidi-override chars (Trojan-Source / spoofing)

/** Plain-text view of `input`: all tags, attributes, scripts, styles, event handlers and URLs-in-markup removed; entities decoded once. */
export function cleanText(input: unknown, maxLen = 10_000): string {
  if (input === null || input === undefined) return "";
  const s = String(input).slice(0, maxLen);
  // HTML can only be introduced with "<"; without it the string is already inert text, so skip the parser (keeps 1M-row views fast).
  const text = s.includes("<")
    ? (DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [], KEEP_CONTENT: true, RETURN_DOM_FRAGMENT: true }).textContent ?? "")
    : s;
  return text.replace(CTRL, "");
}

/** Sanitise every string value of a JSON-like structure (used before putting data into reports / sending it to the API). Depth-limited. */
export function cleanDeep<T>(v: T, depth = 0): T {
  if (depth > 12) return undefined as T;
  if (typeof v === "string") return cleanText(v) as T;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "__proto__" || k === "constructor" || k === "prototype") continue; out[cleanText(k, 200)] = cleanDeep(x, depth + 1); }
    return out as T;
  }
  return v;
}

/** CSV / spreadsheet formula-injection guard: a cell that starts with = + - @ TAB CR would be executed by Excel / Sheets. */
export function csvCell(v: unknown): string {
  let s = typeof v === "number" ? String(v) : cleanText(v, 5000);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
