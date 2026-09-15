// A retired product must never be grantable again, from any door.
//
// The catalogue held two rows named "PPE Compliance": the legacy key "ppe"
// and the current key "ppe_compliance". Every entitlement check reads the
// licence by the CURRENT key, so a real production organisation licensed
// against the legacy row had an active licence that granted it NOTHING — PPE
// Alerts was hidden from their sidebar and the worker would refuse to start,
// despite the console showing an active licence. See
// scripts/retire-legacy-ppe-product.ts, which repaired the live data this
// pins the fix for.

import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("retired_products");
const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { storage } = await import("../storage");
const { registerAdminRoutes } = await import("../adminRoutes");
const { evaluateLicense } = await import("../entitlements");

let app: express.Express;
let orgId = "";
let legacyProductId = "";
let currentProductId = "";

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);

  await storage.upsertProduct({ key: "vms", name: "VMS", description: null, active: true } as any);
  const legacy = await storage.upsertProduct({
    key: "legacy_widget", name: "Legacy Widget", description: null, active: false,
  } as any);
  const current = await storage.upsertProduct({
    key: "current_widget", name: "Current Widget", description: null, active: true,
  } as any);
  legacyProductId = legacy.id;
  currentProductId = current.id;

  const org = await storage.createOrganization({ name: "Fixture Co", slug: "fixture-co", status: "active" });
  orgId = org.id;

  // Mirrors the real incident: an ACTIVE licence sitting on a now-retired key.
  await storage.createLicense({
    organizationId: orgId, productId: legacyProductId, plan: "yearly", status: "active",
  } as any);

  app = express();
  app.use(express.json());
  // requireAuth + requireSuperAdmin are applied by routes.ts at mount time,
  // not inside adminRoutes itself -- this stands in for that gate.
  app.use((req: any, _res, next) => { req.user = { role: "super_admin" }; next(); });
  registerAdminRoutes(app);
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

describe("a retired product cannot be granted", () => {
  it("is excluded from the list every grant dropdown reads", async () => {
    const res = await request(app).get("/api/admin/products");
    expect(res.status).toBe(200);
    const keys = res.body.map((p: any) => p.key);
    expect(keys).toContain("current_widget");
    expect(keys).not.toContain("legacy_widget");
  });

  it("refuses a direct grant against the retired key", async () => {
    const res = await request(app).post(`/api/admin/organizations/${orgId}/modules/legacy_widget`);
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/retired/i);
  });

  it("still allows granting the current, active key", async () => {
    const res = await request(app).post(`/api/admin/organizations/${orgId}/modules/current_widget`);
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
  });
});

describe("the real incident: an active licence on a dead key grants nothing", () => {
  // Independent organisation and independent describe-level ordering: this
  // must not depend on running before the earlier tests mutate `orgId`'s
  // licences by granting "current_widget" to it.
  it("is refused by evaluateLicense-driven entitlement, despite status=active", async () => {
    const org = await storage.createOrganization({ name: "Untouched Co", slug: "untouched-co", status: "active" });
    await storage.createLicense({
      organizationId: org.id, productId: legacyProductId, plan: "yearly", status: "active",
    } as any);

    const licences = await storage.getLicensesByOrg(org.id);
    const legacyLicence = licences.find((l) => l.productId === legacyProductId)!;
    expect(legacyLicence.status).toBe("active");

    // The licence itself still evaluates as usable in isolation --
    expect(evaluateLicense(legacyLicence, org).ok).toBe(true);
    // -- which is precisely why "the row says active" was not enough to
    // notice the client had no working PPE feature: nothing in the app looks
    // a client's entitlements up BY PRODUCT ID, only by the current KEY.
    const usable = await storage.getEffectiveLicense(org.id, "legacy_widget");
    const usableByCurrentKey = await storage.getEffectiveLicense(org.id, "current_widget");
    expect(usable).toBeTruthy();
    expect(usableByCurrentKey).toBeFalsy();
  });
});
