// END-TO-END MULTI-TENANCY TESTS — real Postgres, real routes, two real clients.
//
// The commercial promise being tested: two paying clients share one server and
// must never see each other's cameras, events or analytics, and each receives
// ONLY the features they bought.
//
// Unit tests cover resolveOrgScope and evaluateLicense in isolation, but a leak
// in production would come from a handler forgetting to call them — which only
// an end-to-end test through the actual HTTP layer can catch.
//
// Everything runs in the `isolation_test` schema; the developer's own data in
// `public` is never touched.

// vitest does not read .env, so load it before anything touches DATABASE_URL.
import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { TEST_SCHEMA, testPool, resetSchema, dropSchema } from "./helpers/testDb";

// Point the app's own pool at the test schema BEFORE importing anything that
// creates it. storage.ts builds its Pool at import time from DATABASE_URL.
const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");
process.env.ANALYTICS_INGEST_KEY ||= "legacy-platform-key";

const setupPool = testPool();

// Dynamic imports so the env above is in place first.
const { storage } = await import("../storage");
const { hashPassword } = await import("../auth");
const { registerCameraAnalyticsRoutes } = await import("../cameraAnalyticsRoutes");
const { registerAnalyticsRoutes } = await import("../analyticsRoutes");
const { FEATURE_LABELS, FEATURE_MODULE } = await import("@shared/schema");
const { generateIngestToken, hashIngestToken } = await import("../crypto");

/* ---------------------------------------------------------------- fixtures */
interface Ctx {
  orgId: string;
  admin: string;      // user id
  manager: string;
  employee: string;
  cameraId: string;
}

const ids: { a?: Ctx; b?: Ctx; superAdmin?: string } = {};

/**
 * Test app: real session-free auth shim + the REAL routers.
 *
 * `x-test-user` stands in for a logged-in session so we exercise the actual
 * authorization code (resolveOrgScope, evaluateLicense, ownership checks)
 * without booting recorders, MediaMTX and the analytics supervisor.
 */
function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for express-session only. requireAuth still runs for real, so the
  // user lookup, the disabled-account check and every authorization decision
  // below it are the production code paths, not stubs.
  app.use((req, _res, next) => {
    const uid = req.header("x-test-user");
    (req as any).session = {
      userId: uid || undefined,
      destroy: (cb?: () => void) => cb && cb(),
    };
    next();
  });
  registerCameraAnalyticsRoutes(app);
  registerAnalyticsRoutes(app);
  return app;
}

let app: express.Express;

async function seedOrg(slug: string, features: string[]): Promise<Ctx> {
  const org = await storage.createOrganization({ name: slug, slug, status: "active" });
  const pw = await hashPassword("password12345");
  const mk = async (role: string) =>
    (await storage.createUser({
      username: `${slug}-${role}`,
      email: `${slug}-${role}@test.local`,
      passwordHash: pw,
      organizationId: org.id,
      role,
      status: "active",
    })).id;

  const cam = await storage.createCamera(
    {
      channelId: `${slug}-ch1`,
      name: `${slug} cam`,
      streamUrl: `rtsp://user:secret@10.0.0.1/${slug}`,
      streamType: "rtsp",
      videoCodec: "h264",
      recordingPolicy: "continuous",
      status: "active",
      recordingEnabled: true,
    } as any,
    org.id
  );

  for (const f of features) {
    const product = await storage.getProductByKey(f);
    if (product) {
      await storage.createLicense({
        organizationId: org.id,
        productId: product.id,
        plan: "monthly",
        status: "active",
      } as any);
    }
  }

  return {
    orgId: org.id,
    admin: await mk("client_admin"),
    manager: await mk("client_manager"),
    employee: await mk("client_employee"),
    cameraId: cam.id,
  };
}

beforeAll(async () => {
  await resetSchema(setupPool);
  app = makeApp();

  // Full per-feature product catalogue, same as seed.ts creates on boot.
  for (const [key, label] of Object.entries(FEATURE_LABELS)) {
    await storage.upsertProduct({ key, name: label, description: null, active: true } as any);
  }

  // Client A bought intrusion only. Client B bought loitering + vehicle_count.
  // Both intrusion and loitering are served by the SAME `person` worker, which
  // is exactly the case that would leak if licensing were per-module.
  ids.a = await seedOrg("client-a", ["intrusion"]);
  ids.b = await seedOrg("client-b", ["loitering", "vehicle_count"]);

  const sp = await storage.createUser({
    username: "platform-super",
    email: "super@test.local",
    passwordHash: await hashPassword("password12345"),
    organizationId: null,
    role: "super_admin",
    status: "active",
  });
  ids.superAdmin = sp.id;
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool);
  await setupPool.end();
});

const as = (uid: string) => ({ "x-test-user": uid });

/* ------------------------------------------------------------------ tests */

describe("feature licensing — a client gets ONLY what they bought", () => {
  it("lets client A bind the feature they licensed", async () => {
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "intrusion" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.feature).toBe("intrusion");
    expect(r.body.module).toBe("person");
  });

  it("REFUSES a feature of the same module that was not bought", async () => {
    // The crux of the module-vs-feature split: `loitering` runs in the same
    // `person` worker as A's `intrusion`. Per-module licensing would hand it
    // over for free.
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "loitering" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not licensed/i);
  });

  it("refuses a feature from an entirely different module", async () => {
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "vehicle_count" });
    expect(r.status).toBe(403);
  });

  it("lets client B bind theirs, and refuses client A's feature", async () => {
    const ok = await request(app)
      .post(`/api/cameras/${ids.b!.cameraId}/analytics`)
      .set(as(ids.b!.manager))
      .send({ feature: "loitering" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const no = await request(app)
      .post(`/api/cameras/${ids.b!.cameraId}/analytics`)
      .set(as(ids.b!.manager))
      .send({ feature: "intrusion" });
    expect(no.status).toBe(403);
  });

  it("rejects a feature name that does not exist", async () => {
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "mind_reading" });
    expect(r.status).toBe(400);
  });

  it("stops working the moment the licence is suspended", async () => {
    const lic = await storage.getEffectiveLicense(ids.a!.orgId, "intrusion");
    await storage.updateLicense(lic!.id, { status: "suspended" } as any);
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "intrusion" });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("suspended");
    await storage.updateLicense(lic!.id, { status: "active" } as any);
  });

  it("treats an expired date as expired even if status still says active", async () => {
    const lic = await storage.getEffectiveLicense(ids.a!.orgId, "intrusion");
    await storage.updateLicense(lic!.id, {
      status: "active",
      expiresAt: new Date(Date.now() - 60_000),
    } as any);
    const r = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "intrusion" });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("expired");
    await storage.updateLicense(lic!.id, { expiresAt: null } as any);
  });
});

describe("tenant isolation — no client sees another's data", () => {
  it("does not list another client's bindings", async () => {
    const a = await request(app).get("/api/analytics/bindings").set(as(ids.a!.admin));
    const b = await request(app).get("/api/analytics/bindings").set(as(ids.b!.admin));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.every((r: any) => r.organizationId === ids.a!.orgId)).toBe(true);
    expect(b.body.every((r: any) => r.organizationId === ids.b!.orgId)).toBe(true);
    expect(a.body.some((r: any) => r.feature === "loitering")).toBe(false);
    expect(b.body.some((r: any) => r.feature === "intrusion")).toBe(false);
  });

  it("returns 404 — not 403 — for another client's camera", async () => {
    // 403 would confirm the id exists, which is itself a leak.
    const r = await request(app)
      .get(`/api/cameras/${ids.b!.cameraId}/analytics`)
      .set(as(ids.a!.admin));
    expect(r.status).toBe(404);
  });

  it("cannot bind a feature to another client's camera", async () => {
    const r = await request(app)
      .post(`/api/cameras/${ids.b!.cameraId}/analytics`)
      .set(as(ids.a!.manager))
      .send({ feature: "intrusion" });
    expect(r.status).toBe(404);
  });

  it("cannot patch, restart or delete another client's binding", async () => {
    const list = await request(app).get("/api/analytics/bindings").set(as(ids.b!.admin));
    const victim = list.body[0];
    expect(victim).toBeTruthy();

    for (const call of [
      request(app).patch(`/api/analytics/bindings/${victim.id}`)
        .set(as(ids.a!.manager)).send({ enabled: false }),
      request(app).post(`/api/analytics/bindings/${victim.id}/restart`)
        .set(as(ids.a!.manager)),
      request(app).delete(`/api/analytics/bindings/${victim.id}`)
        .set(as(ids.a!.manager)),
    ]) {
      const r = await call;
      expect(r.status).toBe(404);
    }

    // ...and it is genuinely still there afterwards.
    const after = await storage.getCameraAnalytics(victim.id);
    expect(after).toBeTruthy();
    expect(after!.enabled).toBe(true);
  });

  it("does not return another client's analytics events", async () => {
    const camA = ids.a!.cameraId;
    const camB = ids.b!.cameraId;
    await storage.createAnalyticsEvent({
      organizationId: ids.a!.orgId, cameraId: camA,
      module: "person", type: "intrusion", trackId: 1, details: { secret: "A" }, snapshot: null,
    } as any);
    await storage.createAnalyticsEvent({
      organizationId: ids.b!.orgId, cameraId: camB,
      module: "person", type: "loitering", trackId: 2, details: { secret: "B" }, snapshot: null,
    } as any);

    const a = await request(app).get("/api/analytics/events").set(as(ids.a!.employee));
    const b = await request(app).get("/api/analytics/events").set(as(ids.b!.employee));
    expect(a.body.every((e: any) => e.organizationId === ids.a!.orgId)).toBe(true);
    expect(b.body.every((e: any) => e.organizationId === ids.b!.orgId)).toBe(true);
    expect(JSON.stringify(a.body)).not.toContain('"B"');
    expect(JSON.stringify(b.body)).not.toContain('"A"');
  });

  it("ignores a client's attempt to target another org explicitly", async () => {
    // resolveOrgScope must take the org from the session, never from input.
    const r = await request(app)
      .get(`/api/analytics/bindings?orgId=${ids.b!.orgId}`)
      .set(as(ids.a!.admin));
    expect(r.status).toBe(200);
    expect(r.body.every((x: any) => x.organizationId === ids.a!.orgId)).toBe(true);
  });

  it("rejects unauthenticated access outright", async () => {
    expect((await request(app).get("/api/analytics/bindings")).status).toBe(401);
    expect((await request(app).get("/api/analytics/events")).status).toBe(401);
  });
});

describe("role-based access within one client", () => {
  it("lets an employee read", async () => {
    const r = await request(app).get("/api/analytics/bindings").set(as(ids.a!.employee));
    expect(r.status).toBe(200);
  });

  it("does NOT let an employee bind, patch or delete", async () => {
    const post = await request(app)
      .post(`/api/cameras/${ids.a!.cameraId}/analytics`)
      .set(as(ids.a!.employee)).send({ feature: "intrusion" });
    expect(post.status).toBe(403);

    const list = await request(app).get("/api/analytics/bindings").set(as(ids.a!.admin));
    const own = list.body[0];
    const del = await request(app)
      .delete(`/api/analytics/bindings/${own.id}`).set(as(ids.a!.employee));
    expect(del.status).toBe(403);
  });

  it("does not let an employee acknowledge an alert", async () => {
    const ev = await request(app).get("/api/analytics/events").set(as(ids.a!.admin));
    const r = await request(app)
      .post(`/api/analytics/events/${ev.body[0].id}/ack`)
      .set(as(ids.a!.employee));
    expect(r.status).toBe(403);
  });

  it("lets a manager acknowledge", async () => {
    const ev = await request(app).get("/api/analytics/events").set(as(ids.a!.admin));
    const r = await request(app)
      .post(`/api/analytics/events/${ev.body[0].id}/ack`)
      .set(as(ids.a!.manager));
    expect(r.status).toBe(200);
  });

  it("refuses a disabled user even with a valid id", async () => {
    await storage.setUserStatus(ids.a!.employee, "disabled");
    const r = await request(app).get("/api/analytics/bindings").set(as(ids.a!.employee));
    // requireAuth is not mounted on this shim, so the org check is what rejects
    // it; either way the request must not succeed with data.
    expect([401, 403]).toContain(r.status);
    await storage.setUserStatus(ids.a!.employee, "active");
  });
});

describe("super admin", () => {
  it("sees nothing without naming an org", async () => {
    // super_admin has no org of their own; without ?orgId there is no scope,
    // which must be an error rather than "everything".
    const r = await request(app).get("/api/analytics/bindings").set(as(ids.superAdmin!));
    expect(r.status).toBe(400);
  });

  it("can target a specific client explicitly", async () => {
    const r = await request(app)
      .get(`/api/analytics/bindings?orgId=${ids.b!.orgId}`)
      .set(as(ids.superAdmin!));
    expect(r.status).toBe(200);
    expect(r.body.every((x: any) => x.organizationId === ids.b!.orgId)).toBe(true);
  });
});

describe("worker ingest — a stolen token cannot cross tenants", () => {
  it("rejects a missing or wrong key", async () => {
    const none = await request(app).post("/api/analytics/events")
      .send({ module: "person", type: "intrusion", cameraId: ids.a!.cameraId });
    expect(none.status).toBe(401);

    const wrong = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", "not-a-real-token")
      .send({ module: "person", type: "intrusion", cameraId: ids.a!.cameraId });
    expect(wrong.status).toBe(401);
  });

  it("accepts an org token for that org's own camera", async () => {
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));
    const r = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", type: "intrusion", cameraId: ids.a!.cameraId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("REFUSES client A's token posting to client B's camera", async () => {
    // The scenario this defends: a token leaks from one on-prem site and is
    // used to inject events into another client's dashboard.
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));
    const r = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", type: "intrusion", cameraId: ids.b!.cameraId });
    expect(r.status).toBe(403);
  });

  it("honours the explicit `feature` the worker sends", async () => {
    // Workers now name their feature. A person worker posting `loitering`
    // must be refused for client A even though its module (`person`) is the
    // same one their licensed `intrusion` runs in.
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));

    const denied = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", feature: "loitering", type: "loitering",
              cameraId: ids.a!.cameraId });
    expect(denied.status).toBe(403);
    expect(denied.body.feature).toBe("loitering");

    const allowed = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", feature: "intrusion", type: "intrusion",
              cameraId: ids.a!.cameraId });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it("licences a recovery event as its base feature", async () => {
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));
    const r = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", feature: "intrusion", type: "intrusion_cleared",
              cameraId: ids.a!.cameraId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("falls back to the event type when no feature is sent", async () => {
    // Backward compatibility with an older worker build: without this the
    // module name would be looked up as a product and every event would 403.
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));
    const r = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "person", type: "intrusion", cameraId: ids.a!.cameraId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses an event for a module the org is not licensed for", async () => {
    const token = generateIngestToken();
    await storage.setOrgIngestKeyHash(ids.a!.orgId, hashIngestToken(token));
    const r = await request(app).post("/api/analytics/events")
      .set("X-Ingest-Key", token)
      .send({ module: "loitering", type: "loitering", cameraId: ids.a!.cameraId });
    expect(r.status).toBe(403);
  });
});

describe("camera credentials at rest", () => {
  it("stores the RTSP URL encrypted but returns it decrypted", async () => {
    const cam = await storage.getCamera(ids.a!.cameraId);
    expect(cam!.streamUrl).toContain("secret");        // callers see plaintext

    const raw = await setupPool.query(
      `SELECT stream_url FROM ${TEST_SCHEMA}.cameras WHERE id = $1`,
      [ids.a!.cameraId]
    );
    const stored = raw.rows[0].stream_url as string;
    expect(stored.startsWith("v1:")).toBe(true);        // ciphertext at rest
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("10.0.0.1");
  });
});
