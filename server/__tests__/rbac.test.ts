// Tenant isolation + licence gating.
//
// resolveOrgScope is the single choke point that keeps one client from seeing
// another's data; evaluateLicense decides whether a module runs at all. A
// regression in either is a cross-tenant data leak or an unlicensed module, so
// both are pinned here.

import { describe, it, expect } from "vitest";
import { resolveOrgScope, ROLE_RANK } from "../rbac";
import { evaluateLicense } from "../entitlements";
import type { License, Organization } from "@shared/schema";

const req = (user: any, query: any = {}, body: any = {}) =>
  ({ user, query, body }) as any;

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

describe("resolveOrgScope — tenant isolation", () => {
  it("scopes client roles to their own org", () => {
    for (const role of ["client_admin", "client_manager", "client_employee"]) {
      expect(resolveOrgScope(req({ role, organizationId: ORG_A }))).toBe(ORG_A);
    }
  });

  it("IGNORES a client's attempt to target another org", () => {
    // The whole point of the choke point: scope comes from the session, never
    // from caller-supplied input.
    const r = req({ role: "client_admin", organizationId: ORG_A }, { orgId: ORG_B }, { organizationId: ORG_B });
    expect(resolveOrgScope(r)).toBe(ORG_A);
  });

  it("lets super_admin target an org explicitly", () => {
    expect(resolveOrgScope(req({ role: "super_admin" }, { orgId: ORG_B }))).toBe(ORG_B);
    expect(resolveOrgScope(req({ role: "super_admin" }, {}, { organizationId: ORG_B }))).toBe(ORG_B);
  });

  it("returns null for super_admin with no target and for anonymous", () => {
    expect(resolveOrgScope(req({ role: "super_admin" }))).toBeNull();
    expect(resolveOrgScope(req(undefined))).toBeNull();
  });

  it("returns null when a client role somehow has no org", () => {
    expect(resolveOrgScope(req({ role: "client_admin", organizationId: null }))).toBeNull();
  });
});

describe("role ranking", () => {
  it("orders privileges correctly", () => {
    expect(ROLE_RANK.client_employee).toBeLessThan(ROLE_RANK.client_manager);
    expect(ROLE_RANK.client_manager).toBeLessThan(ROLE_RANK.client_admin);
    expect(ROLE_RANK.client_admin).toBeLessThan(ROLE_RANK.super_admin);
  });
});

const lic = (over: Partial<License> = {}): License =>
  ({
    id: "l1",
    organizationId: ORG_A,
    productId: "p1",
    plan: "monthly",
    status: "active",
    issuedAt: new Date(),
    expiresAt: null,
    limits: null,
    machineFingerprint: null,
    signedLicense: null,
    lastValidatedAt: null,
    ...over,
  }) as License;

const org = (status = "active"): Organization =>
  ({ id: ORG_A, name: "A", slug: "a", status, ingestKeyHash: null, createdAt: new Date() }) as Organization;

describe("evaluateLicense — module entitlement", () => {
  it("accepts an active, non-expiring licence", () => {
    expect(evaluateLicense(lic(), org()).ok).toBe(true);
  });

  it("rejects when the org itself is suspended", () => {
    // Org suspension must beat an otherwise-valid licence.
    const r = evaluateLicense(lic(), org("suspended"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("org_suspended");
  });

  it("rejects a missing licence", () => {
    expect(evaluateLicense(undefined, org()).reason).toBe("no_license");
  });

  it("rejects suspended and expired statuses", () => {
    expect(evaluateLicense(lic({ status: "suspended" }), org()).reason).toBe("suspended");
    expect(evaluateLicense(lic({ status: "expired" }), org()).reason).toBe("expired");
  });

  it("evaluates expiry live, not just the stored status", () => {
    // A licence still marked "active" but past its date must not pass — this is
    // what makes a lapsed client stop working without a nightly job.
    const past = new Date(Date.now() - 60_000);
    const r = evaluateLicense(lic({ status: "active", expiresAt: past }), org());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("expired");
  });

  it("accepts a future expiry", () => {
    const future = new Date(Date.now() + 86_400_000);
    expect(evaluateLicense(lic({ expiresAt: future }), org()).ok).toBe(true);
  });
});
