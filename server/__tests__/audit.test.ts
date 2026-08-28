// The audit trail is a compliance artefact, so it is only worth having if it
// cannot leak, cannot be forged, and cannot itself become the leak.
//
// Three failure modes are tested here, all of which have shipped in real
// products:
//   1. the trail stores the secret it was recording ("password changed to X")
//   2. one tenant can read another tenant's trail
//   3. a failing audit write takes down the action it was recording
//
// Runs against real Postgres in its own test schema; the developer's own
// data in `public` is never touched.

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

// Own schema: vitest runs files in parallel and a shared one collides.
const TEST_SCHEMA = schemaFor("audit");

const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { audit, listAudit, scrubDetail } = await import("../audit");
const { storage } = await import("../storage");
const { validatePasswordStrength } = await import("../auth");

let ORG_A = "";
let ORG_B = "";

/** Minimal Express-shaped request: audit only reads user, ip and headers. */
function fakeReq(user: any, headers: Record<string, string> = {}) {
  return {
    user,
    ip: "203.0.113.7",
    socket: { remoteAddress: "203.0.113.7" },
    header: (k: string) => headers[k.toLowerCase()],
  } as any;
}

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  const a = await storage.createOrganization({ name: "Client A", slug: "client-a" });
  const b = await storage.createOrganization({ name: "Client B", slug: "client-b" });
  ORG_A = a.id;
  ORG_B = b.id;
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

/* ------------------------------------------------------------ secrets */

describe("the trail never becomes the leak", () => {
  it("redacts passwords, tokens and stream URLs at any depth", () => {
    const out: any = scrubDetail({
      password: "hunter2",
      passwordHash: "$2b$12$abc",
      streamUrl: "rtsp://admin:CameraPass1@10.0.0.5/Streaming/Channels/101",
      nested: { apiKey: "sk-live-123", inner: { ingestKey: "tok_abc" } },
      keptField: "this is fine",
    });

    expect(out.password).toBe("[redacted]");
    expect(out.passwordHash).toBe("[redacted]");
    expect(out.streamUrl).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested.inner.ingestKey).toBe("[redacted]");
    expect(out.keptField).toBe("this is fine");

    // The decisive check: the camera password must not survive ANYWHERE in the
    // serialised object, however it was nested.
    expect(JSON.stringify(out)).not.toContain("CameraPass1");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("matches secret keys regardless of naming convention", () => {
    const out: any = scrubDetail({
      stream_url: "rtsp://x", STREAMURL: "rtsp://y", "api-key": "z", userPassword: "p",
    });
    expect(Object.values(out).every((v) => v === "[redacted]")).toBe(true);
  });

  it("does not store a face embedding", () => {
    // An embedding is biometric data; it reconstructs identity. It must not sit
    // in the most widely-read table in the product.
    const out: any = scrubDetail({ embedding: [0.1, 0.2, 0.3], name: "Priya" });
    expect(out.embedding).toBe("[redacted]");
    expect(out.name).toBe("Priya"); // a name is the point of the audit row
  });

  it("survives a cyclic object instead of hanging the request", () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(() => scrubDetail(cyclic)).not.toThrow();
  });

  it("writes a redacted row end to end", async () => {
    await audit(fakeReq({ id: "u1", username: "admin_a", role: "client_admin", organizationId: ORG_A }), {
      action: "camera_updated",
      targetType: "camera",
      targetId: "cam-1",
      targetLabel: "Gate 3",
      detail: { streamUrl: "rtsp://admin:LeakMe99@10.0.0.9/live", changedFields: ["streamUrl"] },
    });

    const rows = await listAudit({ organizationId: ORG_A });
    const row = rows.find((r) => r.targetId === "cam-1")!;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain("LeakMe99");
    expect((row.detail as any).changedFields).toEqual(["streamUrl"]);
  });
});

/* ------------------------------------------------------- tenant scoping */

describe("tenant scoping", () => {
  it("never shows one client another client's trail", async () => {
    await audit(fakeReq({ id: "u2", username: "admin_b", role: "client_admin", organizationId: ORG_B }), {
      action: "recording_viewed",
      targetType: "recording",
      targetId: "cam-b/recording-1.mp4",
      targetLabel: "Client B — Vault Corridor",
    });

    const aRows = await listAudit({ organizationId: ORG_A });
    // The camera NAME is the disclosure — it describes another client's site.
    expect(JSON.stringify(aRows)).not.toContain("Vault Corridor");
    expect(JSON.stringify(aRows)).not.toContain("admin_b");
  });

  it("returns nothing when no org can be resolved", async () => {
    // Fail closed: a client role with no org must never fall through to the
    // unfiltered trail.
    expect(await listAudit({ organizationId: null })).toEqual([]);
  });

  it("lets super_admin see across tenants", async () => {
    const all = await listAudit({ organizationId: null, isSuperAdmin: true });
    const orgs = new Set(all.map((r) => r.organizationId));
    expect(orgs.size).toBeGreaterThan(1);
  });

  it("caps the result size so one query cannot pull the whole table", async () => {
    const rows = await listAudit({ organizationId: null, isSuperAdmin: true, limit: 99999 });
    expect(rows.length).toBeLessThanOrEqual(1000);
  });
});

/* ------------------------------------------------- non-fatal by design */

describe("auditing never breaks the action it records", () => {
  it("swallows a write failure and says exactly what was lost", async () => {
    const { db } = await import("../storage");
    const spy = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errs: string[] = [];
    const cErr = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });

    // Must not throw: a client losing camera access because the audit table is
    // full would be a self-inflicted outage.
    await expect(
      audit(fakeReq({ id: "u1", username: "admin_a", role: "client_admin", organizationId: ORG_A }), {
        action: "camera_deleted",
        targetType: "camera",
        targetId: "cam-9",
      })
    ).resolves.toBeUndefined();

    // And the log must name the action and actor, not just "db error".
    const joined = errs.join("\n");
    expect(joined).toContain("AUDIT WRITE FAILED");
    expect(joined).toContain("camera_deleted");
    expect(joined).toContain("admin_a");

    spy.mockRestore();
    cErr.mockRestore();
  });

  it("records a failed login with the attempted name but no password", async () => {
    await audit(fakeReq(undefined), {
      action: "login_failed",
      outcome: "denied",
      organizationId: ORG_A,
      actor: { username: "sprayed_user" },
      detail: { reason: "unknown_account", password: "should-never-appear" },
    });

    const rows = await listAudit({ organizationId: ORG_A, action: "login_failed" });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUsername).toBe("sprayed_user");
    expect(rows[0].outcome).toBe("denied");
    expect(JSON.stringify(rows[0])).not.toContain("should-never-appear");
  });

  it("records the origin IP so a brute-force source is identifiable", async () => {
    const rows = await listAudit({ organizationId: ORG_A, action: "login_failed" });
    expect(rows[0].ipAddress).toBe("203.0.113.7");
  });

  it("does not take the origin IP from a caller-supplied header", async () => {
    // req.ip honours Express's `trust proxy` setting; reading X-Forwarded-For
    // directly would let any caller forge their own origin and the trail lies.
    await audit(fakeReq({ id: "u1", username: "admin_a", role: "client_admin", organizationId: ORG_A },
      { "x-forwarded-for": "1.2.3.4" }), {
      action: "logout",
    });
    const rows = await listAudit({ organizationId: ORG_A, action: "logout" });
    expect(rows[0].ipAddress).toBe("203.0.113.7");
    expect(rows[0].ipAddress).not.toBe("1.2.3.4");
  });
});

/* --------------------------------------------- policy applied EVERYWHERE */

describe("password policy is enforced on every path that sets one", () => {
  // Three code paths set passwords: /api/admin/users (super_admin),
  // /api/org/users (client_admin), and /api/auth/change-password (self).
  // Each previously had its own minimum — 12, 8 and 8 — so a client_admin
  // could mint an account weaker than the platform's own stated rule, and a
  // user could self-downgrade below it. One function, one rule.
  it("rejects an 8-character password that older paths accepted", () => {
    expect(validatePasswordStrength("Abcd1234")).not.toBeNull();
    expect(validatePasswordStrength("admin123")).not.toBeNull();
  });

  it("accepts the same value everywhere once it meets the policy", () => {
    expect(validatePasswordStrength("correct horse battery staple")).toBeNull();
  });
});

/* ------------------------------------------------------ password policy */

describe("password policy", () => {
  it("rejects the passwords that actually get set in the field", () => {
    for (const weak of ["admin123", "password123", "Welcome123", "cctv1234", "12345678"]) {
      expect(validatePasswordStrength(weak), weak).not.toBeNull();
    }
  });

  it("rejects a password containing the username", () => {
    expect(validatePasswordStrength("hyperspark2026!", "hyperspark")).not.toBeNull();
  });

  it("accepts a long passphrase without demanding symbols", () => {
    // NIST SP 800-63B: length beats forced complexity, which just produces
    // "P@ssw0rd!". A long simple phrase is stronger and gets remembered.
    expect(validatePasswordStrength("correct horse battery staple")).toBeNull();
  });

  it("states what is wrong rather than just refusing", () => {
    const msg = validatePasswordStrength("short1");
    expect(msg).toMatch(/at least 12 characters/);
  });
});
