import "dotenv/config";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";
const schema = schemaFor("console");
const base = process.env.DATABASE_URL!;
process.env.DATABASE_URL =
  base +
  (base.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${schema}`;
process.env.SESSION_SECRET ||= "console-test-session-secret";
const keyDir = mkdtempSync(path.join(tmpdir(), "vms-console-keys-"));
process.env.LICENSE_KEY_DIR = keyDir;
process.env.LICENSE_PRIVATE_KEY_PATH = path.join(
  keyDir,
  "license-signing-private.pem",
);
process.env.LICENSE_PUBLIC_KEY_PATH = path.join(
  keyDir,
  "license-signing-public.pem",
);
const setup = testPool(schema);
const { storage, pool } = await import("../storage");
const { registerRoutes } = await import("../routes");
const { requireAuth } = await import("../auth");
const { ensureSigningKeys, verifyLicense } = await import("../licenseCrypto");
const { usageForAllOrgs } = await import("../limits");
const { createLocation } = await import("../locations");
const { emitEvent, clearEvents } = await import("../events");
let app: express.Express;
let orgId: string;
let licenseId: string;
const ids: Record<string, string> = {};
const camera = (i: number) =>
  ({
    name: `Camera ${i}`,
    channelId: `channel-${i}`,
    streamUrl: "rtsp://user:private@127.0.0.1/fixture",
    streamType: "rtsp",
    recordingEnabled: false,
    status: "active",
  }) as any;
beforeAll(async () => {
  await resetSchema(setup, schema);
  ensureSigningKeys();
  const org = await storage.createOrganization({
    name: "Console client",
    slug: "console-client",
  });
  orgId = org.id;
  const product = await storage.upsertProduct({
    key: "vms",
    name: "VMS",
    active: true,
  });
  const lic = await storage.createLicense({
    organizationId: orgId,
    productId: product.id,
    plan: "yearly",
    status: "active",
  });
  licenseId = lic.id;
  for (const role of [
    "super_admin",
    "client_admin",
    "client_manager",
    "client_employee",
  ]) {
    const u = await storage.createUser({
      username: role,
      email: `${role}@console.test`,
      role,
      organizationId: role === "super_admin" ? null : orgId,
      passwordHash: "test-only",
      status: "active",
    });
    ids[role] = u.id;
  }
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = {
      userId: req.header("x-test-user"),
      destroy: (cb?: () => void) => cb?.(),
    };
    next();
  });
  await registerRoutes(app, { startBackgroundServices: false });
}, 60000);
afterAll(async () => {
  await pool.end();
  await dropSchema(setup, schema);
  await setup.end();
  rmSync(keyDir, { recursive: true, force: true });
});
const get = (url: string, role = "super_admin") =>
  request(app).get(url).set("x-test-user", ids[role]);
const patch = (url: string, body: unknown) =>
  request(app).patch(url).set("x-test-user", ids.super_admin).send(body);

describe("console permissions and bounded queries", () => {
  it.each(["client_admin", "client_manager", "client_employee"])(
    "denies every platform screen API to %s",
    async (role) => {
      for (const endpoint of [
        "console/overview",
        "console/clients",
        "console/admins",
        "console/licenses",
        "console/audit",
        "console/notifications",
        "system",
        "settings",
        "console-models",
      ])
        expect(
          (await get(`/api/admin/${endpoint}`, role)).status,
          endpoint,
        ).toBe(403);
    },
  );
  it("denies anonymous access", async () =>
    expect((await request(app).get("/api/admin/console/overview")).status).toBe(
      401,
    ));
  it("returns usable pagination and rejects unbounded input", async () => {
    for (let i = 0; i < 22; i++)
      await storage.createOrganization({
        name: `Page client ${i}`,
        slug: `page-${i}`,
      });
    const a = await get("/api/admin/console/clients?pageSize=20");
    const b = await get("/api/admin/console/clients?page=2&pageSize=20");
    expect(a.status).toBe(200);
    expect(a.body.total).toBe(23);
    expect(a.body.rows).toHaveLength(20);
    expect(b.body.rows).toHaveLength(3);
    expect(
      new Set([...a.body.rows, ...b.body.rows].map((x) => x.organizationId))
        .size,
    ).toBe(23);
    expect(
      (await get("/api/admin/console/clients?pageSize=10000")).status,
    ).toBe(400);
    expect(
      (await get("/api/admin/console/clients?search=Console%20client")).body
        .total,
    ).toBe(1);
  });
  it("never returns camera credentials or user password hashes in read models", async () => {
    await storage.createCamera(camera(0), orgId);
    const usage = await get(
      "/api/admin/console/clients?search=Console%20client",
    );
    // A camera with no recorder process is UNKNOWN, not online.
    //
    // This used to read `online === 1`, because health was derived from the
    // `cameras.status` column — a flag set once at creation that nothing ever
    // updates. That made the platform console report every configured camera
    // as online, so a site whose cameras were all dead still showed green.
    // Health now comes from the live recorder processes, and a camera this
    // process does not supervise is reported as unknown rather than guessed at.
    expect(usage.body.rows[0].health.online).toBe(0);
    expect(usage.body.rows[0].health.unknown).toBe(1);
    expect(JSON.stringify(usage.body)).not.toMatch(
      /rtsp:|passwordHash|private/,
    );
    const admins = await get("/api/admin/console/admins");
    expect(admins.body.rows).toHaveLength(1);
    expect(admins.body.rows[0].role).toBe("client_admin");
    expect(JSON.stringify(admins.body)).not.toContain("passwordHash");
  });
  it("returns effective expiry without changing the stored license status", async () => {
    await storage.updateLicense(licenseId, {
      expiresAt: new Date("2020-01-01"),
    });
    const result = await get("/api/admin/console/licenses?status=expired");
    expect(result.body.rows[0].status).toBe("expired");
    expect(result.body.rows[0].storedStatus).toBe("active");
    await storage.updateLicense(licenseId, { expiresAt: null });
  });
  it("shows only platform and aggregate notifications", async () => {
    clearEvents();
    emitEvent("camera_added", "private camera", {
      id: "camera",
      name: "secret",
      organizationId: orgId,
    });
    emitEvent("quota_warning", "Client allowance warning", undefined, orgId);
    const response = await get("/api/admin/console/notifications");
    expect(response.body).toHaveLength(1);
    expect(response.body[0].type).toBe("quota_warning");
  });
  it("mounts real health and read-only configuration endpoints", async () => {
    const system = await get("/api/admin/system");
    expect(system.status).toBe(200);
    expect(system.body.host.timezone).toBeTruthy();
    expect(system.body).toHaveProperty("checkedAt");
    const settings = await get("/api/admin/settings");
    expect(settings.status).toBe(200);
    expect(settings.body.map((g: any) => g.group)).toContain("Security");
    expect(JSON.stringify(settings.body)).not.toMatch(
      /SESSION_SECRET|DATABASE_URL|PRIVATE_KEY/,
    );
  });
});
describe("allowances remain correct at creation boundaries", () => {
  it("counts sites only, allowing nested floors under a capped site", async () => {
    await storage.updateLicense(licenseId, { limits: { maxSites: 1 } });
    const site = await createLocation(orgId, { name: "Site", kind: "site" });
    await createLocation(orgId, {
      name: "Floor",
      kind: "floor",
      parentId: site.id,
    });
    const usage = (await usageForAllOrgs()).find(
      (o) => o.organizationId === orgId,
    )!;
    expect(usage.usage.find((u) => u.key === "maxSites")?.used).toBe(1);
    await expect(
      createLocation(orgId, { name: "Another site", kind: "site" }),
    ).rejects.toThrow(/Sites limit/);
    const response = await request(app)
      .post("/api/locations")
      .set("x-test-user", ids.client_manager)
      .send({ name: "Another floor", kind: "floor", parentId: site.id });
    expect(response.status).toBe(201);
  });
  it("prevents changing a floor into an extra site", async () => {
    const floor = await createLocation(orgId, {
      name: "Convertible floor",
      kind: "floor",
    });
    const response = await request(app)
      .patch(`/api/locations/${floor.id}`)
      .set("x-test-user", ids.client_admin)
      .send({ kind: "site" });
    expect(response.status).toBe(403);
  });
  it("serializes simultaneous camera creation without exceeding the allowance", async () => {
    await storage.updateLicense(licenseId, { limits: { maxCameras: 2 } });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((i) => storage.createCamera(camera(i), orgId)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await storage.countCamerasByOrg(orgId)).toBe(2);
  });
  it("enforces the user limit through the Super Admin endpoint", async () => {
    await storage.updateLicense(licenseId, { limits: { maxUsers: 3 } });
    const response = await request(app)
      .post("/api/admin/users")
      .set("x-test-user", ids.super_admin)
      .send({
        username: "additional",
        email: "additional@console.test",
        role: "client_admin",
        organizationId: orgId,
        password: "A different secure phrase 123",
      });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Users limit/);
  });
  it("invalidates portable license terms after an allowance update", async () => {
    await patch(`/api/admin/licenses/${licenseId}`, { plan: "yearly" });
    const response = await patch(`/api/admin/organizations/${orgId}/limits`, {
      maxCameras: 250,
      maxSites: 4,
    });
    expect(response.status).toBe(200);
    const download = await get(`/api/admin/licenses/${licenseId}/file`);
    const verified = verifyLicense(
      Buffer.isBuffer(download.body) ? download.body.toString() : download.text,
    );
    expect(verified.ok).toBe(true);
    expect(verified.payload?.limits?.maxCameras).toBe(250);
  });
  it("preserves existing allowances when granting an existing module", async () => {
    const response = await request(app)
      .post("/api/admin/licenses")
      .set("x-test-user", ids.super_admin)
      .send({
        organizationId: orgId,
        productKey: "vms",
        plan: "yearly",
        status: "active",
      });
    expect(response.status).toBe(201);
    expect(response.body.limits.maxCameras).toBe(250);
  });
  it("validates before changing state and records client/license edits in audit", async () => {
    expect(
      (await patch(`/api/admin/organizations/${orgId}`, { name: "  " })).status,
    ).toBe(400);
    expect(
      (
        await patch(`/api/admin/licenses/${licenseId}`, {
          expiresAt: "nonsense",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch(`/api/admin/users/${ids.client_admin}`, {
          status: "disabled",
          password: "short",
        })
      ).status,
    ).toBe(400);
    expect((await storage.getUser(ids.client_admin))?.status).toBe("active");
    await patch(`/api/admin/organizations/${orgId}`, {
      name: "Renamed client",
    });
    await patch(`/api/admin/licenses/${licenseId}`, { plan: "monthly" });
    const audit = await get(`/api/admin/console/audit?orgId=${orgId}`);
    expect(audit.status).toBe(200);
    expect(audit.body.rows.map((r: any) => r.action)).toContain(
      "organization_updated",
    );
    expect(audit.body.rows.map((r: any) => r.action)).toContain(
      "license_updated",
    );
  });
});
