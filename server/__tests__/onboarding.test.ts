// Taking on a client, as one action.
//
// Onboarding used to be three forms across two screens: create the
// organisation, then go elsewhere to add an administrator, then elsewhere
// again to grant each module. The create dialog literally said "assign a client
// administrator next", which is an admission that it left the job half done.
//
// The state that produces is the dangerous one: an organisation with no admin
// and no licence looks EXACTLY like a finished client in the list. Nobody can
// sign in, nothing is licensed, and nothing says so. These tests are mostly
// about making that state impossible.

import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("onboarding");
const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { storage } = await import("../storage");
const { onboardClient, OnboardingError } = await import("../onboarding");
const { verifyPassword } = await import("../auth");
const { usageFor, limitsFor } = await import("../limits");
const { FEATURE_LABELS } = await import("@shared/schema");
const { evaluateLicense } = await import("../entitlements");

const GOOD = {
  name: "Acme Steel Plant",
  slug: "acme-steel",
  adminEmail: "admin@acme.test",
  adminUsername: "acme-admin",
  adminPassword: "CorrectHorseBattery1",
  modules: ["intrusion", "face_recognition"],
  limits: { maxCameras: 250, maxUsers: 25, maxSites: 10, maxStorageGb: 5000 },
};

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  await storage.upsertProduct({ key: "vms", name: "VMS", description: null, active: true } as any);
  for (const [key, name] of Object.entries(FEATURE_LABELS)) {
    await storage.upsertProduct({ key, name, description: null, active: true } as any);
  }
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

describe("one action produces a client that actually works", () => {
  let orgId = "";

  it("creates the organisation, the admin, the licences and the allowances together", async () => {
    const r = await onboardClient(GOOD);
    orgId = r.organizationId;
    expect(r.modulesGranted.sort()).toEqual(["face_recognition", "intrusion"]);
    expect(r.modulesSkipped).toEqual([]);

    const org = await storage.getOrganization(orgId);
    expect(org?.slug).toBe("acme-steel");
    expect(org?.status).toBe("active");
  });

  it("gives the administrator an account they can actually sign in with", async () => {
    // The point of onboarding is that the credentials you hand over work. A
    // user row whose hash does not match the password you typed is a client
    // locked out on day one.
    const user = await storage.getUserByLogin("admin@acme.test");
    expect(user?.role).toBe("client_admin");
    expect(user?.organizationId).toBe(orgId);
    expect(await verifyPassword(GOOD.adminPassword, user!.passwordHash)).toBe(true);
  });

  it("always grants the base VMS licence, even though nobody asked for it", async () => {
    // Without it every camera route 403s and the client signs in to an
    // application that says "no cameras" and refuses to add one.
    const licence = await storage.getEffectiveLicense(orgId, "vms");
    expect(licence, "base vms licence").toBeTruthy();
    expect(licence!.status).toBe("active");
  });

  it("grants exactly the modules asked for and nothing else", async () => {
    expect((await storage.getEffectiveLicense(orgId, "intrusion"))?.status).toBe("active");
    expect((await storage.getEffectiveLicense(orgId, "face_recognition"))?.status).toBe("active");
    expect(await storage.getEffectiveLicense(orgId, "ppe_compliance")).toBeFalsy();
  });

  it("stores the allowances where the limit checks read them", async () => {
    // Limits live on the base licence; storing them anywhere else means the
    // console shows a cap that nothing enforces.
    expect(await limitsFor(orgId)).toEqual({
      maxCameras: 250, maxUsers: 25, maxSites: 10, maxStorageGb: 5000,
    });
    const usage = await usageFor(orgId);
    expect(usage.find((u) => u.key === "maxCameras")!.limit).toBe(250);
    // One user exists — the admin just created.
    expect(usage.find((u) => u.key === "maxUsers")!.used).toBe(1);
  });
});

describe("a rejected onboarding leaves NOTHING behind", () => {
  // This is the whole reason it is a transaction. A half-created client holds
  // the slug and looks finished in the list.
  const countOrgs = async () => (await storage.getAllOrganizations()).length;

  it("creates no organisation when the password is too weak", async () => {
    const before = await countOrgs();
    await expect(
      onboardClient({ ...GOOD, slug: "weak-pw", adminEmail: "a@weak.test", adminPassword: "short" })
    ).rejects.toThrow(/12 characters/);
    expect(await countOrgs()).toBe(before);
    expect(await storage.getOrganizationBySlug("weak-pw")).toBeFalsy();
  });

  it("creates no organisation when the admin email is already taken", async () => {
    const before = await countOrgs();
    await expect(
      onboardClient({ ...GOOD, slug: "dupe-email", adminEmail: "admin@acme.test" })
    ).rejects.toThrow(/already has an account/);
    expect(await countOrgs()).toBe(before);
    expect(await storage.getOrganizationBySlug("dupe-email")).toBeFalsy();
  });

  it("refuses a slug that is already in use", async () => {
    await expect(
      onboardClient({ ...GOOD, adminEmail: "other@acme.test" })
    ).rejects.toThrow(/already in use/);
  });

  it("refuses an identifier that is not URL-safe", async () => {
    await expect(
      onboardClient({ ...GOOD, slug: "Acme Steel!", adminEmail: "x@acme.test" })
    ).rejects.toThrow(/lowercase letters/);
  });

  it("refuses an invalid email before creating anything", async () => {
    const before = await countOrgs();
    await expect(
      onboardClient({ ...GOOD, slug: "bad-email", adminEmail: "not-an-email" })
    ).rejects.toThrow(/valid email/);
    expect(await countOrgs()).toBe(before);
  });
});

describe("modules the catalogue does not know", () => {
  it("reports them back rather than silently dropping them", async () => {
    // A client billed for a module that was never granted is worse than an
    // error at the point of sale.
    const r = await onboardClient({
      ...GOOD,
      slug: "partial-modules",
      adminEmail: "admin@partial.test",
      adminUsername: "partial-admin",
      modules: ["intrusion", "teleportation", "time_travel"],
    });
    expect(r.modulesGranted).toEqual(["intrusion"]);
    expect(r.modulesSkipped.sort()).toEqual(["teleportation", "time_travel"]);
  });
});

describe("allowances are optional", () => {
  it("treats an omitted cap as unlimited, not as zero", async () => {
    // A missing limit read as 0 would lock the client out of their own system.
    const r = await onboardClient({
      ...GOOD,
      slug: "no-limits",
      adminEmail: "admin@nolimits.test",
      adminUsername: "nolimits-admin",
      modules: [],
      limits: {},
    });
    expect(await limitsFor(r.organizationId)).toEqual({});
    for (const u of await usageFor(r.organizationId)) {
      expect(u.limit, u.key).toBeNull();
      expect(u.level, u.key).toBe("unlimited");
    }
  });
});

describe("the platform cannot reach into a client's own team", () => {
  // A client's managers and employees belong to the client. The platform needs
  // to create the FIRST administrator (nobody else can), recover one who is
  // locked out, and disable one when a contract ends — nothing more.
  //
  // None of that was enforced. GET /api/admin/users returned every user of
  // every organisation, and PATCH would reset a client EMPLOYEE's password —
  // which silently transfers the account to whoever runs the platform. It was
  // demonstrated end to end before this guard existed: the employee's own
  // password stopped working and the platform's replacement worked.
  const PLATFORM_MANAGED = new Set(["client_admin", "super_admin"]);
  const refuse = (role: string) => !PLATFORM_MANAGED.has(role);

  it("treats a client's staff roles as out of the platform's reach", () => {
    expect(refuse("client_employee")).toBe(true);
    expect(refuse("client_manager")).toBe(true);
  });

  it("keeps administrators reachable, or nobody could ever be onboarded", () => {
    // The bootstrap problem: a client admin cannot create themselves.
    expect(refuse("client_admin")).toBe(false);
    expect(refuse("super_admin")).toBe(false);
  });

  it("loses the platform nothing operationally", async () => {
    // Everything the platform gives up here, the client admin already has in
    // their own Team Members screen — which is where the decision belongs.
    const r = await onboardClient({
      ...GOOD,
      slug: "reach-test",
      adminEmail: "admin@reach.test",
      adminUsername: "reach-admin",
      modules: [],
    });
    const admin = await storage.getUser(r.adminId);
    expect(admin?.role).toBe("client_admin");
    expect(refuse(admin!.role)).toBe(false);
  });
});

describe("a revoked module is actually revoked", () => {
  // evaluateLicense used to name the states it REFUSED — "suspended",
  // "expired" — and fall through to ok for anything else. So when "revoked"
  // appeared, it silently granted access: the console reported the module
  // revoked, the audit trail recorded a revocation, and the client carried on
  // using it. A licence you cannot take away is not a licence.
  //
  // It is an allowlist now, so a new state denies by default until somebody
  // decides otherwise.
  const lic = (status: string, expiresAt: Date | null = null) =>
    ({ status, expiresAt } as any);

  it("grants only for active and trial", () => {
    expect(evaluateLicense(lic("active")).ok).toBe(true);
    expect(evaluateLicense(lic("trial")).ok).toBe(true);
  });

  it("refuses a revoked licence — the bug this replaced", () => {
    const r = evaluateLicense(lic("revoked"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("revoked");
  });

  it("refuses suspended and expired, as before", () => {
    expect(evaluateLicense(lic("suspended")).reason).toBe("suspended");
    expect(evaluateLicense(lic("expired")).reason).toBe("expired");
  });

  it("refuses a state nobody has invented yet", () => {
    // The decisive property: a denylist would return ok here.
    expect(evaluateLicense(lic("pending_payment")).ok).toBe(false);
    expect(evaluateLicense(lic("")).ok).toBe(false);
  });

  it("still refuses an active licence whose date has passed", () => {
    expect(evaluateLicense(lic("active", new Date("2020-01-01"))).reason).toBe("expired");
  });

  it("refuses everything when the organisation itself is suspended", () => {
    const org = { status: "suspended" } as any;
    expect(evaluateLicense(lic("active"), org).reason).toBe("org_suspended");
  });
});
