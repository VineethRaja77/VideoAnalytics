// server/licenseService.ts
//
// Bridges the license DB rows to the cryptographic layer. Runs on the cloud
// authority: it signs a portable license token whenever a license is issued
// or changed, and answers on-prem phone-home checks (the authority is the
// live source of truth for suspend/revoke; the signed token is the offline
// fallback bound to a specific machine).

import { storage } from "./storage";
import { signLicense, newNonce, type LicensePayload } from "./licenseCrypto";
import { evaluateLicense } from "./entitlements";

/**
 * (Re)sign the token for a license row and persist it in `signedLicense`.
 * Called after every issue/patch so the downloadable .lic always reflects
 * current terms (plan, expiry, machine binding).
 */
export async function regenerateSignedLicense(licenseId: string): Promise<string | null> {
  const license = await storage.getLicense(licenseId);
  if (!license) return null;
  const [org, products] = await Promise.all([
    storage.getOrganization(license.organizationId),
    storage.getAllProducts(),
  ]);
  const product = products.find((p) => p.id === license.productId);
  if (!org || !product) return null;

  const payload: LicensePayload = {
    v: 1,
    licenseId: license.id,
    organizationId: org.id,
    organizationName: org.name,
    productKey: product.key,
    plan: license.plan,
    status: license.status,
    issuedAt: (license.issuedAt ? new Date(license.issuedAt) : new Date()).toISOString(),
    expiresAt: license.expiresAt ? new Date(license.expiresAt).toISOString() : null,
    machineFingerprint: license.machineFingerprint ?? null,
    limits: (license.limits as Record<string, unknown> | null) ?? null,
    nonce: newNonce(),
  };

  const token = signLicense(payload);
  await storage.updateLicense(licenseId, { signedLicense: token });
  return token;
}

export interface PhoneHomeResult {
  valid: boolean;
  status: string;
  reason?: string;
  machineMatch: boolean;
  token?: string; // fresh signed token when valid
}

/**
 * Authority-side phone-home: an on-prem install presents its licenseId and
 * machine fingerprint; the cloud returns the live status, whether the machine
 * still matches, and a refreshed token. This is how suspend/revoke propagates.
 */
export async function validatePhoneHome(licenseId: string, machineFingerprint: string): Promise<PhoneHomeResult> {
  const license = await storage.getLicense(licenseId);
  if (!license) return { valid: false, status: "unknown", reason: "no_license", machineMatch: false };

  const org = await storage.getOrganization(license.organizationId);
  const check = evaluateLicense(license, org);
  const machineMatch = !license.machineFingerprint || license.machineFingerprint === machineFingerprint;

  await storage.updateLicense(licenseId, { lastValidatedAt: new Date() });

  if (!check.ok) return { valid: false, status: license.status, reason: check.reason, machineMatch };
  if (!machineMatch) return { valid: false, status: license.status, reason: "machine_mismatch", machineMatch };

  const token = await regenerateSignedLicense(licenseId);
  return { valid: true, status: license.status, machineMatch: true, token: token ?? undefined };
}
