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
  reason?: "no_license" | "suspended" | "expired" | "org_suspended";
}

/** Pure validity computation — expiry is evaluated live, not just from stored status. */
export function evaluateLicense(license: License | undefined, org?: Organization): LicenseCheck {
  if (org && org.status === "suspended") return { ok: false, reason: "org_suspended" };
  if (!license) return { ok: false, reason: "no_license" };
  if (license.status === "suspended") return { ok: false, reason: "suspended" };
  if (license.status === "expired") return { ok: false, reason: "expired" };
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
export function requireModule(productKey: string): RequestHandler {
  return async (req, res, next) => {
    try {
      if (req.user?.role === "super_admin") return next();

      // On-prem: gate on the signed license (crypto), not the local DB.
      if (isOnPrem()) {
        const ent = getLocalEntitlement(productKey);
        if (!ent.valid) {
          return res.status(403).json({ error: "Module not available", module: productKey, reason: ent.reason });
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
          error: "Module not available",
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
