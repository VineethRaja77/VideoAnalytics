// CSRF origin checking and schema-drift detection.
//
// Both exist because of concrete failures rather than theory:
//
//   * SameSite=lax compares the REGISTRABLE DOMAIN, so a VMS at
//     vms.example.com gets no SameSite protection from anything else hosted at
//     another subdomain of example.com. A neighbouring app with an XSS could
//     drive authenticated state changes here.
//
//   * A development box ran for weeks with migrations 0004/0005 unapplied. The
//     symptoms were a seed crash and "Failed to restore analytics workers" —
//     neither mentions the schema. The test suite passed the whole time because
//     tests build their own schema and cannot see drift in the real one.

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("hardening");

const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { requireSameOrigin } = await import("../security");
const { findSchemaProblems } = await import("../schemaCheck");

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

/* ------------------------------------------------------------------ CSRF */

function csrfApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use("/api", requireSameOrigin);
  a.get("/api/thing", (_req, res) => res.json({ ok: true }));
  a.post("/api/thing", (_req, res) => res.json({ ok: true }));
  a.delete("/api/thing", (_req, res) => res.json({ ok: true }));
  a.post("/api/analytics/events", (_req, res) => res.json({ ok: true }));
  return a;
}

describe("CSRF origin check", () => {
  const app = csrfApp();

  it("blocks a state-changing request from another origin", async () => {
    const res = await request(app)
      .post("/api/thing")
      .set("Origin", "https://evil.example.net")
      .set("Host", "vms.example.com");
    expect(res.status).toBe(403);
  });

  it("blocks a SIBLING SUBDOMAIN — the case SameSite does not cover", async () => {
    // vms.example.com and label.example.com share a registrable domain, so the
    // browser considers them same-site and WILL send the session cookie. This
    // check is the only thing standing between them.
    const res = await request(app)
      .delete("/api/thing")
      .set("Origin", "https://label.example.com")
      .set("Host", "vms.example.com");
    expect(res.status).toBe(403);
  });

  it("allows a request from its own origin", async () => {
    const res = await request(app)
      .post("/api/thing")
      .set("Origin", "http://127.0.0.1:5000")
      .set("Host", "127.0.0.1:5000");
    expect(res.status).toBe(200);
  });

  it("never blocks a GET — safe methods change nothing", async () => {
    const res = await request(app)
      .get("/api/thing")
      .set("Origin", "https://evil.example.net")
      .set("Host", "vms.example.com");
    expect(res.status).toBe(200);
  });

  it("allows a non-browser caller that sends no Origin or Referer", async () => {
    // curl, a worker, a health probe. No ambient cookie authority, so nothing
    // to forge — blocking these would break every integration.
    const res = await request(app).post("/api/thing").set("Host", "vms.example.com");
    expect(res.status).toBe(200);
  });

  it("allows worker ingest carrying its own key", async () => {
    // Machine-to-machine with a bearer credential a browser cannot be tricked
    // into supplying.
    const res = await request(app)
      .post("/api/analytics/events")
      .set("X-Ingest-Key", "some-worker-key")
      .set("Origin", "https://elsewhere.example.net")
      .set("Host", "vms.example.com");
    expect(res.status).toBe(200);
  });

  it("falls back to Referer when Origin is absent", async () => {
    const res = await request(app)
      .post("/api/thing")
      .set("Referer", "https://evil.example.net/page")
      .set("Host", "vms.example.com");
    expect(res.status).toBe(403);
  });

  it("honours ALLOWED_ORIGINS for a split UI/API deployment", async () => {
    process.env.ALLOWED_ORIGINS = "https://ui.client.example";
    const app2 = csrfApp();
    const ok = await request(app2)
      .post("/api/thing")
      .set("Origin", "https://ui.client.example")
      .set("Host", "api.client.example");
    expect(ok.status).toBe(200);

    const blocked = await request(app2)
      .post("/api/thing")
      .set("Origin", "https://other.example")
      .set("Host", "api.client.example");
    expect(blocked.status).toBe(403);
    delete process.env.ALLOWED_ORIGINS;
  });
});

/* ------------------------------------------------- camera secret decryption */

describe("every camera getter decrypts", () => {
  // A getter that forgets decryptCamera hands the RAW CIPHERTEXT to whatever
  // consumes it. For getRecordingEnabledCameras — the boot path — that meant
  // MediaMTX received "v1:xxxx:yyyy:zzzz" as a stream URL, rejected it with
  // "invalid source", and recording never resumed after a restart, for every
  // camera at once, with nothing in the UI to indicate why.
  it("returns a usable rtsp:// URL from the recorder boot path", async () => {
    const { storage } = await import("../storage");
    const org = await storage.createOrganization({ name: "Decrypt Co", slug: "decrypt-co" });
    const plain = "rtsp://admin:SomePass1@10.0.0.4/Streaming/Channels/101";

    await storage.createCamera(
      {
        name: "Boot Path Camera",
        channelId: "ch-decrypt",
        streamUrl: plain,
        streamType: "rtsp",
        videoCodec: "h264",
        recordingPolicy: "continuous",
        recordingEnabled: true,
      } as any,
      org.id
    );

    const cams = await storage.getRecordingEnabledCameras();
    const cam = cams.find((c) => c.channelId === "ch-decrypt")!;
    expect(cam).toBeDefined();
    expect(cam.streamUrl).toBe(plain);
    // The decisive assertion: never the stored ciphertext envelope.
    expect(cam.streamUrl.startsWith("v1:")).toBe(false);
  });
});

/* ------------------------------------------------- worker environment */

describe("analytics module environments", () => {
  // The supervisor launches each module with models/<module>/.venv/bin/python
  // and used to fall back to system python3 when that was missing. The fallback
  // is silently fatal — the worker dies on `import dotenv` before printing
  // anything, and restart-loops forever producing no events. Four of six
  // modules were in exactly this state on the development box.
  it("reports every installed module's environment as ready", async () => {
    const { moduleEnvReady } = await import("../analyticsWorker");
    const fs = await import("fs");
    const path = await import("path");
    const base = process.env.MODELS_BASE || path.join(process.cwd(), "models");

    const missing = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, "worker.py")))
      .map((e) => e.name)
      .filter((m) => !moduleEnvReady(m));

    // A failure here means those analytics cannot start on this host.
    // Fix: ./scripts/install-models.sh <module>
    expect(missing).toEqual([]);
  });

  it("treats a module with no requirements.txt as ready", async () => {
    // Not every module needs an environment; requiring one would block a
    // pure-config module from ever starting.
    const { moduleEnvReady } = await import("../analyticsWorker");
    expect(moduleEnvReady("definitely-not-a-real-module")).toBe(true);
  });
});

/* ---------------------------------------------------------- schema drift */

describe("schema drift detection", () => {

  it("reports nothing when the schema is complete", async () => {
    expect(await findSchemaProblems()).toEqual([]);
  });

  it("detects a MISSING TABLE and names the migration that creates it", async () => {
    // Exactly the incident this was written for: camera_analytics absent
    // because migration 0005 was never applied.
    await setupPool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.camera_analytics CASCADE`);

    const problems = await findSchemaProblems();
    const p = problems.find((x) => x.table === "camera_analytics");
    expect(p).toBeDefined();
    expect(p!.tableMissing).toBe(true);
    // The message must tell an installer what to run, not just that something
    // is wrong.
    expect(p!.migration).toContain("0005");
  });

  it("detects a MISSING COLUMN from a partially applied migration", async () => {
    // The other half of the same incident: organizations existed, but without
    // ingest_key_hash, so per-org worker tokens failed with a column error.
    await setupPool.query(
      `ALTER TABLE ${TEST_SCHEMA}.organizations DROP COLUMN IF EXISTS ingest_key_hash`
    );

    const problems = await findSchemaProblems();
    const p = problems.find((x) => x.table === "organizations");
    expect(p).toBeDefined();
    expect(p!.missingColumns).toContain("ingest_key_hash");
    expect(p!.migration).toContain("0004");
  });
});
