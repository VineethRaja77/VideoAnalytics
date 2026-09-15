// END-TO-END face enrolment — real Postgres, real routes, the real Python bridge.
//
// The commercial promise: a client admin can enrol their own staff from a
// browser, and CANNOT under any circumstances touch another client's.
//
// Face embeddings are biometric personal data under India's DPDP Act 2023, so
// the tenancy boundary here is not just a product concern, it is a personal
// data breach if it fails. The gallery is chosen from the SESSION's
// organisation, so these tests specifically try to get at another org's gallery
// through every field a caller controls.
//
// The Python bridge is NOT mocked. Mocking it would test the mock: the whole
// risk is that Node and Python disagree about which file to open.

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("face");
const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { storage } = await import("../storage");
const { hashPassword } = await import("../auth");
const { registerFaceRoutes } = await import("../faceRoutes");
const { galleryPathForOrg } = await import("../analyticsWorker");
const { FEATURE_LABELS } = await import("@shared/schema");

interface Ctx {
  orgId: string;
  admin: string;
  employee: string;
}

const ids: { a?: Ctx; b?: Ctx; unlicensed?: Ctx } = {};

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => {
    const uid = req.header("x-test-user");
    (req as any).session = { userId: uid || undefined, destroy: (cb?: () => void) => cb && cb() };
    next();
  });
  registerFaceRoutes(app);
  return app;
}

async function seedOrg(slug: string, licensed: boolean): Promise<Ctx> {
  const org = await storage.createOrganization({ name: slug, slug, status: "active" });
  const pw = await hashPassword("password12345");
  const mk = async (role: string) =>
    (
      await storage.createUser({
        username: `${slug}-${role}`,
        email: `${slug}-${role}@test.local`,
        passwordHash: pw,
        organizationId: org.id,
        role,
        status: "active",
      })
    ).id;

  if (licensed) {
    const product = await storage.getProductByKey("face_recognition");
    if (product) {
      await storage.createLicense({
        organizationId: org.id,
        productId: product.id,
        plan: "monthly",
        status: "active",
      } as any);
    }
  }
  return { orgId: org.id, admin: await mk("client_admin"), employee: await mk("client_employee") };
}

let app: express.Express;
const written: string[] = [];

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  app = makeApp();
  for (const [key, label] of Object.entries(FEATURE_LABELS)) {
    await storage.upsertProduct({ key, name: label, description: null, active: true } as any);
  }
  ids.a = await seedOrg("face-a", true);
  ids.b = await seedOrg("face-b", true);
  ids.unlicensed = await seedOrg("face-none", false);
}, 60_000);

afterAll(async () => {
  // Real galleries were written to models/face/gallery — remove them so a test
  // run never leaves a stray tenant's file on a developer's disk.
  for (const p of written) {
    for (const f of [p, p.replace(".npz", ".json")]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

const as = (uid: string) => ({ "x-test-user": uid });

/** A valid JPEG with no face in it — enough to prove the plumbing works. */
const BLANK_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKAAoDASIA" +
  "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA" +
  "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3" +
  "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm" +
  "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA" +
  "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx" +
  "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK" +
  "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3" +
  "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii" +
  "gD//2Q==";

describe("tenancy — one client's gallery is unreachable from another", () => {
  it("gives each organisation its own gallery FILE", () => {
    // The whole boundary rests on this. If two orgs ever resolved to one path,
    // client B's cameras would match client A's staff.
    expect(galleryPathForOrg(ids.a!.orgId)).not.toBe(galleryPathForOrg(ids.b!.orgId));
    expect(path.basename(galleryPathForOrg(ids.a!.orgId))).toBe(`${ids.a!.orgId}.npz`);
  });

  it("lists only the caller's own organisation, and starts empty", async () => {
    const a = await request(app).get("/api/face/people").set(as(ids.a!.admin));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.people).toEqual([]);

    const b = await request(app).get("/api/face/people").set(as(ids.b!.admin));
    expect(b.status).toBe(200);
    expect(b.body.people).toEqual([]);
  });

  it("never lets a request name the gallery it writes to", async () => {
    // Every field a caller controls is tried. The org comes from the session,
    // so none of these can redirect the write.
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({
        name: "mallory",
        images: [BLANK_JPEG_B64],
        purpose: "Site access control",
        consentConfirmed: true,
        organizationId: ids.b!.orgId,
        galleryPath: galleryPathForOrg(ids.b!.orgId),
        GALLERY_PATH: galleryPathForOrg(ids.b!.orgId),
      });
    // The photo has no face, so nothing is enrolled — but crucially nothing was
    // written to B's gallery either.
    expect([201, 422]).toContain(r.status);
    expect(fs.existsSync(galleryPathForOrg(ids.b!.orgId))).toBe(false);
  });
});

describe("licence gating", () => {
  it("refuses an organisation without a face licence", async () => {
    const r = await request(app).get("/api/face/people").set(as(ids.unlicensed!.admin));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not licensed/i);
  });

  it("refuses an unauthenticated caller", async () => {
    const r = await request(app).get("/api/face/people");
    expect(r.status).toBe(401);
  });
});

describe("role separation", () => {
  it("lets an employee READ who is enrolled", async () => {
    const r = await request(app).get("/api/face/people").set(as(ids.a!.employee));
    expect(r.status).toBe(200);
  });

  it("does NOT let an employee enrol anyone", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.employee))
      .send({
        name: "someone",
        images: [BLANK_JPEG_B64],
        purpose: "Site access control",
        consentConfirmed: true,
      });
    expect(r.status).toBe(403);
  });

  it("does NOT let an employee delete anyone", async () => {
    const r = await request(app)
      .delete("/api/face/people/someone")
      .set(as(ids.a!.employee));
    expect(r.status).toBe(403);
  });
});

describe("input validation", () => {
  it("rejects a name that the gallery's fixed-width dtype would truncate", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "x".repeat(200), images: [BLANK_JPEG_B64] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/128 characters/);
  });

  it("rejects an empty name", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "   ", images: [BLANK_JPEG_B64] });
    expect(r.status).toBe(400);
  });

  it("rejects a submission with no photographs", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "ramesh", images: [] });
    expect(r.status).toBe(400);
  });

  it("caps the number of photographs per request", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "ramesh", images: Array(50).fill(BLANK_JPEG_B64) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/At most 10/);
  });
});

describe("honest failure", () => {
  it("says WHY a photograph could not be used, per photograph", async () => {
    // A blank image is the cheapest reproducible version of the real failure:
    // an admin uploads a picture where the face cannot be found or is too
    // small, and needs to be told which one and why — not "enrolment failed".
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({
        name: "ramesh",
        images: [BLANK_JPEG_B64],
        purpose: "Site access control",
        consentConfirmed: true,
      });

    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/could be used/i);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].accepted).toBe(false);
    expect(r.body.results[0].reason).toMatch(/no face/i);
  });

  it("does not create a person when every photograph was rejected", async () => {
    const r = await request(app).get("/api/face/people").set(as(ids.a!.admin));
    expect(r.body.people).toEqual([]);
  });

  it("treats removing someone who is not enrolled as a no-op, not an error", async () => {
    // A double-click must not produce a failure an admin has to interpret.
    const r = await request(app)
      .delete("/api/face/people/nobody")
      .set(as(ids.a!.admin));
    expect(r.status).toBe(200);
    expect(r.body.wasEnrolled).toBe(false);
  });
});


describe("consent is required, not merely displayed", () => {
  // The DPDP Act 2023 wants the RECORD of consent, not a notice on a screen.
  // An enrolment that cannot say who consented and what for is one that cannot
  // be defended later, so the API refuses it rather than storing a gap.
  it("refuses an enrolment with no stated purpose", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "ramesh", images: [BLANK_JPEG_B64], consentConfirmed: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/used for/i);
  });

  it("refuses an enrolment where consent was not confirmed", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({ name: "ramesh", images: [BLANK_JPEG_B64], purpose: "Access control" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/consent/i);
  });

  it("refuses a purpose too short to mean anything", async () => {
    const r = await request(app)
      .post("/api/face/people")
      .set(as(ids.a!.admin))
      .send({
        name: "ramesh", images: [BLANK_JPEG_B64],
        purpose: "x", consentConfirmed: true,
      });
    expect(r.status).toBe(400);
  });
});

describe("renaming a person", () => {
  it("refuses an employee", async () => {
    const r = await request(app)
      .patch("/api/face/people/ramesh")
      .set(as(ids.a!.employee))
      .send({ name: "Ramesh Kumar" });
    expect(r.status).toBe(403);
  });

  it("refuses a name the gallery dtype would truncate", async () => {
    const r = await request(app)
      .patch("/api/face/people/ramesh")
      .set(as(ids.a!.admin))
      .send({ name: "x".repeat(200) });
    expect(r.status).toBe(400);
  });

  it("reports a person who is not enrolled rather than inventing one", async () => {
    const r = await request(app)
      .patch("/api/face/people/nobody-at-all")
      .set(as(ids.a!.admin))
      .send({ name: "Somebody" });
    expect(r.status).toBe(422);
  });
});
