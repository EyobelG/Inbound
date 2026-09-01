import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption for PII columns (currently `app_users.email`).
 *
 * `app_users.email` is written once per user (`ensureAppUser`) and never
 * queried by value anywhere in the app - no `WHERE email = ...` exists, so
 * there's no deterministic-encryption or searchable-index tradeoff to make.
 * That makes randomized AEAD the right and only choice: AES-256-GCM, a fresh
 * 96-bit IV per encryption, and the GCM auth tag detects any tampering with
 * the stored ciphertext (a corrupted or attacker-modified row fails to
 * decrypt rather than silently returning garbage).
 *
 * Ciphertext is stored as base64(iv[12] || authTag[16] || ciphertext) in the
 * existing `text` column - Postgres text has no length constraint here, so no
 * schema change beyond a documentation comment was needed.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getKey(): Buffer {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PII_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PII_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

export function encryptPII(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Throws on any tampering, truncation, or wrong-key attempt - GCM
 * authentication fails closed rather than returning corrupted plaintext.
 */
export function decryptPII(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext too short to contain an IV and auth tag.");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
