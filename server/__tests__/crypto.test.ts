// Camera credential encryption + ingest token invariants.
//
// These guard the two changes most likely to be broken silently by a future
// refactor: encryption that quietly stops encrypting, and tokens that become
// recoverable from the database.

import { describe, it, expect, beforeAll } from "vitest";

// Must be set before crypto.ts caches the key on first use.
beforeAll(() => {
  process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
});

const {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  generateIngestToken,
  hashIngestToken,
  encryptionAvailable,
} = await import("../crypto");

const RTSP = "rtsp://admin:S3cr3t!Pass@192.168.1.64:554/Streaming/Channels/101";

describe("camera credential encryption", () => {
  it("has a usable key in test env", () => {
    expect(encryptionAvailable()).toBe(true);
  });

  it("round-trips exactly", () => {
    const ct = encryptSecret(RTSP)!;
    expect(decryptSecret(ct)).toBe(RTSP);
  });

  it("never leaves plaintext in the ciphertext", () => {
    const ct = encryptSecret(RTSP)!;
    expect(ct).not.toContain("S3cr3t");
    expect(ct).not.toContain("192.168");
    expect(ct).not.toContain("admin");
  });

  it("is idempotent — double-encrypting does not corrupt", () => {
    const once = encryptSecret(RTSP)!;
    const twice = encryptSecret(once)!;
    expect(twice).toBe(once);
    expect(decryptSecret(twice)).toBe(RTSP);
  });

  it("uses a fresh IV per call so identical inputs differ", () => {
    const a = encryptSecret(RTSP)!;
    const b = encryptSecret(RTSP)!;
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(RTSP);
    expect(decryptSecret(b)).toBe(RTSP);
  });

  it("passes legacy plaintext through unchanged", () => {
    // Installs predating encryption must keep working until backfill runs.
    expect(decryptSecret("rtsp://plain/url")).toBe("rtsp://plain/url");
    expect(isEncrypted("rtsp://plain/url")).toBe(false);
  });

  it("returns null on tampered ciphertext rather than leaking it", () => {
    const ct = encryptSecret(RTSP)!;
    const tampered = ct.slice(0, -8) + "AAAAAAAA";
    // Must be null, never the raw stored string — otherwise ciphertext would
    // end up substituted into an RTSP URL.
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("preserves null/empty without inventing a value", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBeNull();
  });
});

describe("analytics ingest tokens", () => {
  it("mints unique, prefixed tokens", () => {
    const a = generateIngestToken();
    const b = generateIngestToken();
    expect(a).not.toBe(b);
    expect(a.startsWith("vmsing_")).toBe(true);
  });

  it("hashes deterministically to sha256 hex", () => {
    const t = generateIngestToken();
    expect(hashIngestToken(t)).toBe(hashIngestToken(t));
    expect(hashIngestToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is one-way — the stored hash is not the token", () => {
    const t = generateIngestToken();
    const h = hashIngestToken(t);
    expect(h).not.toBe(t);
    expect(h).not.toContain(t.slice(7));
  });

  it("gives different tokens different hashes", () => {
    expect(hashIngestToken(generateIngestToken())).not.toBe(
      hashIngestToken(generateIngestToken())
    );
  });
});
