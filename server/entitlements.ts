// server/entitlements.ts
//
// License validity + per-module gating. A request for a product's routes
// passes only if the caller's org holds a license that is active, not
// suspended, and not past its expiry. Super admin bypasses all of this.
// This same validity logic is reused by Phase 2's cryptographic licensing.

import type { RequestHandler } from "express";
import { storage } from "./storage";
import type { License, Organization } from "@shared/schema";
import { resolveOrgScope } from "./rbac";
import { isOnPrem, getLocalEntitlement } from "./licenseClient";

export interface LicenseCheck {
  ok: boolean;
  /** Why access was refused. `revoked` and any future licence state reach the
   *  caller by name rather than being flattened into a generic refusal, so the
   *  message a client sees says what actually happened. */
  reason?:
    | "no_license"
    | "suspended"
    | "expired"
    | "revoked"
    | "org_suspended"
    | (string & {});
}

/** Pure validity computation — expiry is evaluated live, not just from stored status. */
/**
 * The only licence states that grant access.
 *
 * An ALLOWLIST, deliberately. This used to refuse "suspended" and "expired" by
 * name and fall through to `ok` for anything else — so the moment a third state
 * appeared, it silently granted access. That is exactly what happened with
 * "revoked": the super admin could revoke a module, the console would report it
 * revoked, and the client kept using it. A licence you cannot actually take
 * away is not a licence.
 *
 * Adding a state now denies by default until somebody decides otherwise, which
 * is the right direction for a check that stands between a client and software
 * they have not paid for.
 */
const USABLE_LICENSE_STATUSES = new Set(["active", "trial"]);

export function evaluateLicense(license: License | undefined, org?: Organization): LicenseCheck {
  if (org && org.status === "suspended") return { ok: false, reason: "org_suspended" };
  if (!license) return { ok: false, reason: "no_license" };
  if (!USABLE_LICENSE_STATUSES.has(license.status)) {
    // The status itself is the reason, so "revoked" reads as revoked rather
    // than being flattened into a generic refusal.
    return { ok: false, reason: license.status };
  }
  if (license.expiresAt && new Date(license.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/** Product keys the org currently holds a valid license for (for /api/auth/me). */
export async function getLicensedModules(organizationId: string): Promise<string[]> {
  const products = await storage.getAllProducts();

  // On-prem: entitlement comes from the signed license (crypto), not the
  // local DB the client controls.
  if (isOnPrem()) {
    return products.filter((p) => getLocalEntitlement(p.key).valid).map((p) => p.key);
  }

  const [org, licenses] = await Promise.all([
    storage.getOrganization(organizationId),
    storage.getLicensesByOrg(organizationId),
  ]);
  const keyById = new Map(products.map((p) => [p.id, p.key]));
  return licenses
    .filter((l) => evaluateLicense(l, org).ok)
    .map((l) => keyById.get(l.productId))
    .filter((k): k is string => !!k);
}

/**
 * Gate a product's routes. Super admin bypasses. Otherwise the caller's org
 * must hold a valid license for `productKey`, else 403 with a clear reason
 * the frontend can show ("module suspended", "license expired", etc.).
 */
/** Product keys as a client would say them, for messages a client reads. */
const PRODUCT_NAMES: Record<string, string> = {
  vms: "Video Management",
};

/**
 * Turn an entitlement failure into a sentence that names the problem AND says
 * who can fix it.
 *
 * The audience is a client admin, not a developer: they cannot act on
 * "no_license", and the difference between "you never had this" and "this
 * expired" decides whether they call their supplier or check their billing.
 */
export function describeModuleBlock(productKey: string, reason?: string): string {
  const name = PRODUCT_NAMES[productKey] ?? productKey;
  switch (reason) {
    case "no_license":
      return `${name} is not licensed for your organisation. Cameras, recording and playback stay unavailable until your provider activates it.`;
    case "expired":
      return `Your ${name} licence has expired. Cameras, recording and playback are unavailable until it is renewed.`;
    case "suspended":
    case "revoked":
      return `Your ${name} licence has been ${reason}. Contact your provider to restore access.`;
    case "org_suspended":
      return `This organisation's account is suspended, so ${name} is unavailable. Contact your provider.`;
    default:
      return `${name} is not available for your organisation${reason ? ` (${reason})` : ""}. Contact your provider.`;
  }
}

export function requireModule(productKey: string): RequestHandler {
  return async (req, res, next) => {
    try {
      if (req.user?.role === "super_admin") return next();

      // On-prem: gate on the signed license (crypto), not the local DB.
      if (isOnPrem()) {
        const ent = getLocalEntitlement(productKey);
        if (!ent.valid) {
          return res.status(403).json({
            error: describeModuleBlock(productKey, ent.reason),
            module: productKey,
            reason: ent.reason,
          });
        }
        return next();
      }

      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(403).json({ error: "No organization context" });

      const [org, license] = await Promise.all([
        storage.getOrganization(orgId),
        storage.getEffectiveLicense(orgId, productKey),
      ]);

      const check = evaluateLicense(license, org);
      if (!check.ok) {
        return res.status(403).json({
          // A sentence the person reading it can act on. "Module not available"
          // told a client admin nothing about what to do, and the screen it
          // produced said "No cameras added yet" — so the actual state (an
          // administrative licence problem) was invisible from end to end.
          error: describeModuleBlock(productKey, check.reason),
          module: productKey,
          reason: check.reason,
        });
      }
      next();
    } catch (err) {
      console.error(`❌ requireModule(${productKey}) failed:`, err);
      res.status(500).json({ error: "Entitlement check failed" });
    }
  };
}
