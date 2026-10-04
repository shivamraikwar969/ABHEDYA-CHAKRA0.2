// =====================================================================================
//  FIELD / FILE ENCRYPTION AT REST  -  AES-256-GCM (node:crypto), envelope-style
//
//  * A fresh 256-bit data key is derived per message: HKDF(master, random 16-byte salt)  -> no IV-reuse / nonce-limit concerns.
//  * Random 96-bit IV, 128-bit auth tag. Any bit flip makes decryption throw (authenticated encryption).
//  * `context` (e.g. "users.email:<id>") is bound as Additional Authenticated Data: a ciphertext copied into another
//    field / record / table fails to decrypt, so database rows cannot be shuffled or swapped by an attacker.
//  * The key id is stored in the blob, so keys can be rotated: new writes use the active key, old data still decrypts.
//
//  Blob layout:  ver(1)=1 | keyIdLen(1) | keyId | salt(16) | iv(12) | tag(16) | ciphertext
//  Field string: "enc1:" + base64url(blob)
// =====================================================================================
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { activeKey, deriveKey, keyById } from "./keys.mjs";

const VER = 1, SALT = 16, IV = 12, TAG = 16;
export const FIELD_PREFIX = "enc1:";

export function encryptBuffer(plain, context = "") {
  const { id, key: master } = activeKey();
  const salt = randomBytes(SALT), iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", deriveKey(master, "aes-gcm", salt), iv, { authTagLength: TAG });
  c.setAAD(Buffer.from(String(context), "utf8"));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const kid = Buffer.from(id, "utf8");
  return Buffer.concat([Buffer.from([VER, kid.length]), kid, salt, iv, c.getAuthTag(), ct]);
}

export function decryptBuffer(blob, context = "") {
  if (!Buffer.isBuffer(blob) || blob.length < 2 + SALT + IV + TAG || blob[0] !== VER) throw new Error("decrypt: unsupported or corrupt blob");
  const kidLen = blob[1];
  let o = 2;
  const kid = blob.subarray(o, (o += kidLen)).toString("utf8");
  const k = keyById(kid);
  if (!k) throw new Error(`decrypt: key "${kid}" is not in the key ring`);
  const salt = blob.subarray(o, (o += SALT)), iv = blob.subarray(o, (o += IV)), tag = blob.subarray(o, (o += TAG)), ct = blob.subarray(o);
  const d = createDecipheriv("aes-256-gcm", deriveKey(k.key, "aes-gcm", salt), iv, { authTagLength: TAG });
  d.setAAD(Buffer.from(String(context), "utf8"));
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(ct), d.final()]); }
  catch { throw new Error("decrypt: authentication failed (wrong key, tampered data or wrong context)"); }
}

export const encryptField = (text, context) => FIELD_PREFIX + encryptBuffer(Buffer.from(String(text), "utf8"), context).toString("base64url");
export const isEncryptedField = (v) => typeof v === "string" && v.startsWith(FIELD_PREFIX);
export function decryptField(value, context) {
  if (!isEncryptedField(value)) throw new Error("decrypt: not an encrypted field");
  return decryptBuffer(Buffer.from(value.slice(FIELD_PREFIX.length), "base64url"), context).toString("utf8");
}
/** JSON convenience wrappers for structured sensitive values (dossiers, evidence packs). */
export const encryptJson = (obj, context) => encryptField(JSON.stringify(obj), context);
export const decryptJson = (value, context) => JSON.parse(decryptField(value, context));

/**
 * Deterministic "blind index" so an encrypted column can still be looked up (e.g. login by e-mail) without storing the
 * plaintext: HMAC-SHA256 with a dedicated derived key. Not reversible, not usable across purposes.
 */
export function blindIndex(value, purpose) {
  const { key } = activeKey();
  return createHmac("sha256", deriveKey(key, "blind-index/" + purpose)).update(String(value).normalize("NFKC").trim().toLowerCase()).digest("hex");
}

/** Constant-time string compare. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
