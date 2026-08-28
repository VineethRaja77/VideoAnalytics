// server/crypto.ts
//
// Envelope encryption for secrets at rest — today, camera RTSP passwords.
//
// Camera credentials were previously stored as plaintext in Postgres. On an
// on-prem install the client controls that database, and a DB dump, a backup
// file, or a compromised read-only account handed over every camera's
// credentials. Hashing is not an option: the recorder has to replay the actual
// password to the camera, so it must be reversible — hence AES-256-GCM with a
// key held outside the database.
//
// Format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
// The version prefix lets us rotate the algorithm later, and lets decrypt()
// recognise legacy plaintext rows during migration.

import crypto from "crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "v1";
const IV_BYTES = 12; // GCM standard

let cachedKey: Buffer | null = null;

/**
 * The data-encryption key, from SECRET_ENCRYPTION_KEY (base64 or hex, 32 bytes).
 *
 * Deliberately NOT derived from SESSION_SECRET: rotating a session secret would
 * otherwise silently make every stored camera password undecryptable.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY must be set (32 bytes, base64 or hex). " +
        "Generate one with:  openssl rand -base64 32"
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        "Generate one with:  openssl rand -base64 32"
    );
  }
  cachedKey = key;
  return key;
}

/** True when a key is configured — lets callers degrade instead of crashing. */
export function encryptionAvailable(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/** Encrypt a secret. Returns null/empty unchanged; already-encrypted passes through. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return plain ?? null;
  if (isEncrypted(plain)) return plain; // idempotent — safe to call twice

  // Development escape hatch, gated the same way the boot check gates it, so
  // the two never disagree: previously the startup warning said credentials
  // "remain plaintext" while this function threw instead.
  if (!process.env.SECRET_ENCRYPTION_KEY && process.env.ALLOW_PLAINTEXT_SECRETS === "true") {
    return plain;
  }

  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored secret.
 *
 * A value with no version prefix is a pre-encryption plaintext row and is
 * returned as-is, so existing installs keep working while they are migrated.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return stored ?? null;
  if (!isEncrypted(stored)) return stored; // legacy plaintext

  const parts = stored.split(":");
  if (parts.length !== 4) {
    console.error("❌ decryptSecret: malformed ciphertext");
    return null;
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // Wrong key or tampered ciphertext. Never fall back to returning the raw
    // stored value — that would leak ciphertext into an RTSP URL.
    console.error("❌ decryptSecret failed (wrong SECRET_ENCRYPTION_KEY or tampered data)");
    return null;
  }
}

/** Convenience for `openssl rand -base64 32` equivalence in-process. */
export function generateKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

/* -------------------------------------------------------
   Analytics ingest tokens (per organization)
-------------------------------------------------------- */

/**
 * Mint a worker ingest token. Shown to the operator exactly once — only its
 * hash is persisted, so a database dump does not yield usable tokens.
 */
export function generateIngestToken(): string {
  return `vmsing_${crypto.randomBytes(24).toString("base64url")}`;
}

/** SHA-256 hex of a token. Fast hash is fine: tokens are 192-bit random. */
export function hashIngestToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
