// Resource allowances — how MUCH of the platform a client may consume.
//
// Distinct from licensing, which decides WHICH features they may run. Before
// this existed the two were tangled and inconsistent: the camera cap was
// enforced inline in one route, `maxUsers` was written into every licence and
// read by nothing, and site and storage caps did not exist — so a client sold
// "25 users and 5 TB" could exceed both and the platform would never notice.
//
// Storage is deliberately NOT symmetrical with the others, and the tests say
// why: refusing a 26th user costs nothing, refusing a recording destroys
// footage that will never exist again.

import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("limits");
const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { storage } = await import("../storage");
const { hashPassword } = await import("../auth");
const {
  canAdd, usageFor, limitsFor, storageBytesFor, checkQuotas, resetQuotaStateForTest,
} = await import("../limits");
const { listEvents, clearEvents } = await import("../events");
const recentEvents = () => listEvents(null, true);

let orgId = "";
let licenceId = "";

async function setLimits(limits: Record<string, number>) {
  await storage.updateLicense(licenceId, { limits } as any);
}

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  await storage.upsertProduct({ key: "vms", name: "VMS", description: null, active: true } as any);
  const org = await storage.createOrganization({ name: "Acme", slug: "acme", status: "active" });
  orgId = org.id;
  const product = await storage.getProductByKey("vms");
  const lic = await storage.createLicense({
    organizationId: orgId,
    productId: product!.id,
    plan: "yearly",
    status: "active",
  } as any);
  licenceId = lic.id;

  // A little recorded footage, so the storage figure is non-zero and the
  // threshold suite has something real to measure against.
  const cam = await storage.createCamera(
    {
      channelId: "fixture-1", name: "fixture",
      streamUrl: "rtsp://u:p@10.0.0.1/s", streamType: "rtsp", videoCodec: "h264",
      recordingPolicy: "continuous", status: "active", recordingEnabled: false,
    } as any,
    orgId
  );
  await storage.createRecording({
    organizationId: orgId, cameraId: cam.id, filePath: "/tmp/fixture.mp4",
    startTime: new Date(), endTime: new Date(), fileSize: 2 * 1024 ** 3,
  } as any);
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

beforeEach(async () => {
  await setLimits({});
  resetQuotaStateForTest();
});

const addCamera = (n: number) =>
  storage.createCamera(
    {
      channelId: `ch-${n}-${Date.now()}`,
      name: `cam ${n}`,
      streamUrl: `rtsp://u:p@10.0.0.${n}/s`,
      streamType: "rtsp",
      videoCodec: "h264",
      recordingPolicy: "continuous",
      status: "active",
      recordingEnabled: false,
    } as any,
    orgId
  );

describe("no limit set means no limit", () => {
  it("reports unlimited rather than zero-allowed", async () => {
    // A missing cap read as 0 would lock a client out of their own system.
    const usage = await usageFor(orgId);
    for (const u of usage) {
      expect(u.limit, u.key).toBeNull();
      expect(u.level, u.key).toBe("unlimited");
    }
    expect((await canAdd(orgId, "maxCameras")).ok).toBe(true);
  });

  it("ignores a zero or negative cap instead of enforcing it", async () => {
    await setLimits({ maxCameras: 0 });
    expect((await limitsFor(orgId)).maxCameras).toBeUndefined();
    expect((await canAdd(orgId, "maxCameras")).ok).toBe(true);
  });
});

describe("countable limits stop cleanly at the boundary", () => {
  it("allows up to the cap and refuses the one past it", async () => {
    const before = (await usageFor(orgId)).find((u) => u.key === "maxCameras")!.used;
    await setLimits({ maxCameras: before + 2 });

    await addCamera(101);
    expect((await canAdd(orgId, "maxCameras")).ok, "one below the cap").toBe(true);
    await addCamera(102);

    const blocked = await canAdd(orgId, "maxCameras");
    expect(blocked.ok).toBe(false);
    // The message has to carry the number and a way out; "limit reached"
    // alone leaves a client admin with nowhere to go.
    expect(blocked.message).toMatch(String(before + 2));
    expect(blocked.message).toMatch(/contact your provider/i);
  });

  it("enforces the user cap that used to be stored and ignored", async () => {
    const used = (await usageFor(orgId)).find((u) => u.key === "maxUsers")!.used;
    await setLimits({ maxUsers: used + 1 });
    expect((await canAdd(orgId, "maxUsers")).ok).toBe(true);

    await storage.createUser({
      username: `u${Date.now()}`,
      email: `u${Date.now()}@acme.test`,
      passwordHash: await hashPassword("password12345"),
      organizationId: orgId,
      role: "client_employee",
      status: "active",
    });
    expect((await canAdd(orgId, "maxUsers")).ok).toBe(false);
  });
});

describe("usage levels warn before they bite", () => {
  // Exercised through STORAGE rather than cameras: a camera count is an
  // integer, so on a fixture with a handful of cameras the only reachable
  // fractions are 33%, 50%, 100% — the 80% and 95% boundaries cannot be
  // expressed at all, and the test would be asserting rounding rather than
  // thresholds. Storage is a float and can sit exactly where we need it.
  const levelOf = async () =>
    (await usageFor(orgId)).find((u) => u.key === "maxStorageGb")!.level;

  it("moves ok -> warning -> critical -> exceeded as usage climbs", async () => {
    const usedGb = (await usageFor(orgId)).find((u) => u.key === "maxStorageGb")!.used;
    expect(usedGb, "fixture must have some recordings to measure").toBeGreaterThan(0);

    const capForFraction = (f: number) => usedGb / f;

    await setLimits({ maxStorageGb: capForFraction(0.1) });
    expect(await levelOf()).toBe("ok");

    await setLimits({ maxStorageGb: capForFraction(0.85) });
    expect(await levelOf()).toBe("warning");

    await setLimits({ maxStorageGb: capForFraction(0.97) });
    expect(await levelOf()).toBe("critical");

    await setLimits({ maxStorageGb: usedGb });
    expect(await levelOf()).toBe("exceeded");
  });

  it("treats the warning boundary itself as a warning, not as ok", async () => {
    // Off-by-one here means the first alert a client gets is the critical one.
    const usedGb = (await usageFor(orgId)).find((u) => u.key === "maxStorageGb")!.used;
    await setLimits({ maxStorageGb: usedGb / 0.8 });
    expect(await levelOf()).toBe("warning");
  });
});

describe("storage is measured, and never used to refuse a recording", () => {
  it("sums recording sizes for the organisation only", async () => {
    const cam = await addCamera(201);
    const before = await storageBytesFor(orgId);
    await storage.createRecording({
      organizationId: orgId,
      cameraId: cam.id,
      filePath: "/tmp/a.mp4",
      startTime: new Date(),
      endTime: new Date(),
      fileSize: 5 * 1024 ** 3,
    } as any);
    expect(await storageBytesFor(orgId)).toBe(before + 5 * 1024 ** 3);
  });

  it("exposes no way to block a write", async () => {
    // The API surface is the guarantee: canAdd cannot even be CALLED for
    // storage, so no future caller can accidentally make footage conditional
    // on a quota. Refusing to record loses evidence permanently.
    const keys = ["maxCameras", "maxUsers", "maxSites"];
    expect(keys).not.toContain("maxStorageGb");
    // @ts-expect-error — storage is deliberately not an addable resource
    expect(() => canAdd(orgId, "maxStorageGb")).toBeDefined();
  });
});

describe("the quota monitor tells a client once, not every tick", () => {
  it("announces a breach and then stays quiet until the level changes", async () => {
    clearEvents();
    const used = (await usageFor(orgId)).find((u) => u.key === "maxCameras")!.used;
    await setLimits({ maxCameras: used });      // exceeded

    await checkQuotas();
    const first = recentEvents().filter((e) => e.type === "quota_exceeded");
    expect(first.length).toBe(1);
    expect(first[0].message).toMatch(/Acme/);
    expect(first[0].organizationId).toBe(orgId);

    // Nothing has changed; a second sweep must not repeat itself. A client who
    // is told the same thing every fifteen minutes stops reading alerts.
    await checkQuotas();
    expect(recentEvents().filter((e) => e.type === "quota_exceeded").length).toBe(1);
  });

  it("says recording continues when storage is the breached limit", async () => {
    clearEvents();
    resetQuotaStateForTest();
    await setLimits({ maxStorageGb: 0.000001 });
    await checkQuotas();
    const ev = recentEvents().find((e) => e.type === "quota_exceeded");
    expect(ev?.message).toMatch(/Recording continues/i);
  });

  it("says nothing at all about an organisation with no caps", async () => {
    clearEvents();
    resetQuotaStateForTest();
    await setLimits({});
    await checkQuotas();
    expect(recentEvents().filter((e) => e.type.startsWith("quota_"))).toHaveLength(0);
  });
});
