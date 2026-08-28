// Session security on a SHARED DEVICE — the realistic deployment for a VMS,
// where one control-room PC is used by an admin and by shift employees.
//
// Three things are proven here, against the real Express app and real Postgres:
//
//   1. The session ID is REGENERATED at login. Without it, a session id planted
//      on a shared machine stays valid after a real user signs in and hands the
//      planter that user's session — textbook session fixation.
//   2. A second login rebinds the SAME cookie jar. This is inherent to cookie
//      auth and cannot be fixed server-side; it is pinned here so the behaviour
//      is known, and so the client-side lock has a defined trigger.
//   3. The absolute timeout is enforced SERVER-SIDE, not by cookie expiry —
//      the client controls the cookie and can replay an old one.

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

// Own schema: vitest runs files in parallel and a shared one collides.
const TEST_SCHEMA = schemaFor("session");

const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const { storage } = await import("../storage");
const { hashPassword, setupSession, requireAuth, establishSession } = await import("../auth");

const ADMIN_PW = "correct horse battery staple";
const EMPLOYEE_PW = "another long enough passphrase";

let orgId = "";
let adminId = "";
let employeeId = "";
let app: express.Express;

/**
 * A miniature app carrying the REAL session middleware and REAL requireAuth.
 * The login handler mirrors routes.ts: establishSession, never a direct
 * assignment to req.session.userId.
 */
function buildApp(): express.Express {
  const a = express();
  a.use(express.json());
  setupSession(a);

  a.post("/login", async (req, res) => {
    const user = await storage.getUserByLogin(req.body.login);
    if (!user) return res.status(401).json({ error: "no" });
    await establishSession(req, user.id);
    res.json({ ok: true, userId: user.id });
  });

  // Lets a test force the absolute-timeout branch without waiting 90 days.
  a.post("/backdate", (req, res) => {
    req.session.loginAt = Number(req.body.loginAt);
    req.session.save(() => res.json({ ok: true }));
  });

  a.get("/me", requireAuth, (req, res) => {
    res.json({ userId: req.user!.id, username: req.user!.username, role: req.user!.role });
  });

  a.post("/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
  return a;
}

/** The session cookie from a supertest response, if one was set. */
function cookieOf(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  return (Array.isArray(raw) ? raw : [raw]).find((c) => c.startsWith("vms.sid="))?.split(";")[0];
}

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  const org = await storage.createOrganization({ name: "Client A", slug: "client-a" });
  orgId = org.id;
  const admin = await storage.createUser({
    username: "admin_a", email: "admin@a.test",
    passwordHash: await hashPassword(ADMIN_PW),
    organizationId: orgId, role: "client_admin", status: "active",
  });
  const emp = await storage.createUser({
    username: "employee_a", email: "emp@a.test",
    passwordHash: await hashPassword(EMPLOYEE_PW),
    organizationId: orgId, role: "client_employee", status: "active",
  });
  adminId = admin.id;
  employeeId = emp.id;
  app = buildApp();
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

/* --------------------------------------------------- session fixation */

describe("session fixation", () => {
  it("issues a NEW session id on every login", async () => {
    // saveUninitialized:false means an anonymous request is given no cookie at
    // all, so the attacker's starting point is a session id they obtained by
    // logging in as THEMSELVES — a low-privilege employee account is enough.
    const attacker = request.agent(app);
    const attackerCookie = cookieOf(await attacker.post("/login").send({ login: "emp@a.test" }));
    expect(attackerCookie).toBeDefined();

    // That same id is now planted in the victim's browser (shared kiosk, an
    // XSS on a sibling origin, a crafted link) and the victim signs in.
    const victimLogin = await request(app)
      .post("/login")
      .set("Cookie", attackerCookie!)
      .send({ login: "admin@a.test" });
    expect(victimLogin.status).toBe(200);

    const victimCookie = cookieOf(victimLogin);
    // The decisive assertion, and it now genuinely executes: the admin's
    // session is NOT the id the attacker supplied.
    expect(victimCookie).toBeDefined();
    expect(victimCookie).not.toBe(attackerCookie);
  });

  it("leaves the planted cookie holding NO admin access", async () => {
    const attacker = request.agent(app);
    const planted = cookieOf(await attacker.post("/login").send({ login: "emp@a.test" }));
    expect(planted).toBeDefined();

    await request(app).post("/login").set("Cookie", planted!).send({ login: "admin@a.test" });

    // Replaying the planted id must never yield the admin. Without
    // regenerate() this is precisely where it would return client_admin.
    const replay = await request(app).get("/me").set("Cookie", planted!);
    if (replay.status === 200) {
      expect(replay.body.role).not.toBe("client_admin");
      expect(replay.body.userId).not.toBe(adminId);
    } else {
      expect(replay.status).toBe(401);
    }
  });
});

/* ------------------------------------------------ shared-device reality */

describe("two users, one browser", () => {
  it("rebinds the whole cookie jar when a second user logs in", async () => {
    // Pinned as KNOWN behaviour, not as something desirable: cookies are scoped
    // to the browser profile, so this cannot be fixed server-side. It is why
    // the client polls /api/auth/me and locks the stale tab.
    const browser = request.agent(app);

    await browser.post("/login").send({ login: "admin@a.test" });
    expect((await browser.get("/me")).body.role).toBe("client_admin");

    await browser.post("/login").send({ login: "emp@a.test" });
    const after = await browser.get("/me");

    expect(after.body.role).toBe("client_employee");
    expect(after.body.userId).toBe(employeeId);
    // The admin identity is gone from this browser — which is exactly what the
    // open admin tab must detect before it renders anything else.
    expect(after.body.userId).not.toBe(adminId);
  });

  it("gives the second login a different session id than the first", async () => {
    const browser = request.agent(app);
    const first = cookieOf(await browser.post("/login").send({ login: "admin@a.test" }));
    const second = cookieOf(await browser.post("/login").send({ login: "emp@a.test" }));
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("does not affect a SEPARATE browser profile", async () => {
    // Two devices, or two browser profiles, stay independent — the mixing is
    // strictly within one cookie jar.
    const browserA = request.agent(app);
    const browserB = request.agent(app);

    await browserA.post("/login").send({ login: "admin@a.test" });
    await browserB.post("/login").send({ login: "emp@a.test" });

    expect((await browserA.get("/me")).body.role).toBe("client_admin");
    expect((await browserB.get("/me")).body.role).toBe("client_employee");
  });
});

/* ------------------------------------------------------------ lifetime */

describe("session lifetime", () => {
  it("keeps a user signed in across requests (no re-login per request)", async () => {
    const browser = request.agent(app);
    await browser.post("/login").send({ login: "admin@a.test" });
    for (let i = 0; i < 3; i++) {
      expect((await browser.get("/me")).status).toBe(200);
    }
  });

  it("enforces the absolute cap even when the cookie is still valid", async () => {
    // The client controls the cookie, so expiry cannot be the only limit. Here
    // the cookie is perfectly good and the SERVER refuses on age alone.
    const browser = request.agent(app);
    await browser.post("/login").send({ login: "admin@a.test" });
    expect((await browser.get("/me")).status).toBe(200);

    const ninetyOneDaysAgo = Date.now() - 91 * 24 * 60 * 60 * 1000;
    await browser.post("/backdate").send({ loginAt: ninetyOneDaysAgo });

    const res = await browser.get("/me");
    expect(res.status).toBe(401);
    // The reason is explicit so the UI can say "please sign in again" rather
    // than showing a generic failure.
    expect(res.body.reason).toBe("absolute_timeout");
  });

  it("does NOT expire a long-lived session that is still within the cap", async () => {
    const browser = request.agent(app);
    await browser.post("/login").send({ login: "admin@a.test" });
    await browser.post("/backdate").send({ loginAt: Date.now() - 45 * 24 * 60 * 60 * 1000 });
    expect((await browser.get("/me")).status).toBe(200);
  });

  it("kills a live session the moment the account is disabled", async () => {
    // Disabling a departing employee must take effect now, not in 30 days when
    // their session happens to lapse.
    const browser = request.agent(app);
    await browser.post("/login").send({ login: "emp@a.test" });
    expect((await browser.get("/me")).status).toBe(200);

    await storage.setUserStatus(employeeId, "disabled");
    expect((await browser.get("/me")).status).toBe(403);

    // And the session is destroyed, not merely refused.
    expect((await browser.get("/me")).status).toBe(401);

    await storage.setUserStatus(employeeId, "active");
  });

  it("sets a session cookie that JavaScript cannot read", async () => {
    // httpOnly is what stops XSS from lifting a 30-day session.
    const res = await request(app).post("/login").send({ login: "admin@a.test" });
    const raw = res.headers["set-cookie"] as unknown as string[];
    const cookie = (Array.isArray(raw) ? raw : [raw]).find((c) => c.startsWith("vms.sid="))!;
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });
});
