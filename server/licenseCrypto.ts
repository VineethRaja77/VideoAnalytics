// server/licenseCrypto.ts
//
// In-house cryptographic licensing. The cloud (license authority) holds an
// Ed25519 PRIVATE key and signs license tokens. Every install — including
// on-prem, offline — verifies a token with the embedded PUBLIC key. A token
// is a compact "payload.signature" string (like a mini-JWT): tamper-proof,
// self-contained, and machine-bound.
//
//   Cloud instance : has private + public key → can sign AND verify.
//   On-prem install: ships with public key only → can verify, never forge.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const KEY_DIR = process.env.LICENSE_KEY_DIR || "/etc/vms";
const PRIV_PATH = process.env.LICENSE_PRIVATE_KEY_PATH || path.join(KEY_DIR, "license-signing-private.pem");
const PUB_PATH = process.env.LICENSE_PUBLIC_KEY_PATH || path.join(KEY_DIR, "license-signing-public.pem");

export interface LicensePayload {
  v: 1;
  licenseId: string;
  organizationId: string;
  organizationName: string;
  productKey: string;
  plan: string;
  status: string; // status at signing time (authority is source of truth on phone-home)
  issuedAt: string;
  expiresAt: string | null;
  machineFingerprint: string | null; // null = not machine-locked (e.g. cloud/trial)
  limits: Record<string, unknown> | null;
  nonce: string;
}

let privateKey: crypto.KeyObject | null = null;
let publicKey: crypto.KeyObject | null = null;

/** Cloud authority: ensure a signing keypair exists (generate once), load both. */
export function ensureSigningKeys(): { publicKeyPem: string } {
  if (!fs.existsSync(PUB_PATH) || !fs.existsSync(PRIV_PATH)) {
    const { publicKey: pub, privateKey: priv } = crypto.generateKeyPairSync("ed25519");
    fs.mkdirSync(KEY_DIR, { recursive: true });
    fs.writeFileSync(PRIV_PATH, priv.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    fs.writeFileSync(PUB_PATH, pub.export({ type: "spki", format: "pem" }) as string, { mode: 0o644 });
    console.log("🔑 Generated Ed25519 license-signing keypair");
  }
  privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV_PATH));
  publicKey = crypto.createPublicKey(fs.readFileSync(PUB_PATH));
  return { publicKeyPem: fs.readFileSync(PUB_PATH, "utf8") };
}

/** Any install: load the public key (from file or the LICENSE_PUBLIC_KEY env PEM). */
export function loadPublicKey(): void {
  if (publicKey) return;
  const inlinePem = process.env.LICENSE_PUBLIC_KEY;
  if (inlinePem) {
    publicKey = crypto.createPublicKey(inlinePem.replace(/\\n/g, "\n"));
  } else if (fs.existsSync(PUB_PATH)) {
    publicKey = crypto.createPublicKey(fs.readFileSync(PUB_PATH));
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** Cloud authority only: sign a payload into a portable license token. */
export function signLicense(payload: LicensePayload): string {
  if (!privateKey) throw new Error("Signing key not loaded (call ensureSigningKeys on the authority)");
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.sign(null, Buffer.from(body), privateKey));
  return `${body}.${sig}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: LicensePayload;
  reason?: "malformed" | "bad_signature" | "no_public_key";
}

/** Verify a token's signature and return its payload. Offline, no authority needed. */
export function verifyLicense(token: string): VerifyResult {
  loadPublicKey();
  if (!publicKey) return { ok: false, reason: "no_public_key" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  let payload: LicensePayload;
  try {
    payload = JSON.parse(fromB64url(body).toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = crypto.verify(null, Buffer.from(body), publicKey, fromB64url(sig));
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, payload };
}

export function newNonce(): string {
  return crypto.randomBytes(12).toString("hex");
}
