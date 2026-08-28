// server/auth.ts
import bcrypt from "bcrypt";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Express, Request, RequestHandler } from "express";
import { pool, storage } from "./storage";
import type { User } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    /** Epoch ms of the ORIGINAL login. Never refreshed — enforces the absolute cap. */
    loginAt?: number;
  }
}

/**
 * Idle timeout: the session dies after this long with no requests. Every
 * request resets it (`rolling: true`), so an everyday user is never logged out.
 */
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_DAYS || 30) * 24 * 60 * 60 * 1000;

/**
 * Absolute cap: the maximum life of one login regardless of activity. This is
 * the control that matters — without it a cookie copied off a device stays
 * valid forever as long as something keeps using it. Re-authentication is
 * forced at this point even for a user who is active daily.
 */
const ABSOLUTE_TIMEOUT_MS = Number(process.env.SESSION_ABSOLUTE_DAYS || 90) * 24 * 60 * 60 * 1000;

// The authenticated user, loaded fresh onto every request by requireAuth.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in .env — refusing to start with an insecure default");
}

export function setupSession(app: Express): void {
  const PgSession = connectPgSimple(session);

  app.use(
    session({
      store: new PgSession({ pool, createTableIfMissing: true, tableName: "session" }),
      secret: SESSION_SECRET as string,
      resave: false,
      saveUninitialized: false,
      // Re-send the cookie on every response so the idle window restarts. Without
      // this the cookie expires a fixed 30 days after LOGIN and an active user is
      // still thrown out mid-shift.
      rolling: true,
      name: "vms.sid",
      cookie: {
        httpOnly: true,          // JS cannot read it → XSS cannot steal the session
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",         // blocks cross-site CSRF while allowing normal navigation
        maxAge: IDLE_TIMEOUT_MS,
      },
    })
  );
}

/**
 * The 50 passwords that actually get set on systems like this. Not a security
 * boundary — rate limiting and bcrypt are — but it stops the specific case of a
 * client admin provisioning "admin123" on a system holding CCTV footage.
 */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssword", "p@ssw0rd",
  "admin", "admin123", "admin1234", "administrator", "root", "root123",
  "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop",
  "welcome", "welcome1", "welcome123", "letmein", "letmein123",
  "iloveyou", "sunshine", "princess", "football", "baseball", "monkey123",
  "abc12345", "changeme", "changeme123", "default", "default123",
  "vms12345", "camera123", "hikvision", "dahua123", "cctv1234",
  "test1234", "demo1234", "guest123", "user1234", "temp1234",
  "india123", "bharat123", "company123", "office123", "secure123", "master123",
]);

/**
 * Enforce a minimum password quality. Returns null when acceptable, otherwise a
 * message that says exactly what is wrong — an admin who is told only "invalid
 * password" will retry variations of the same weak one.
 *
 * Length is weighted over composition rules deliberately: NIST SP 800-63B
 * dropped mandatory complexity because it pushes people to "P@ssw0rd!", which
 * is weaker than a long simple phrase. Length is the requirement; composition
 * only applies to shorter passwords.
 */
export function validatePasswordStrength(plain: string, username?: string): string | null {
  if (typeof plain !== "string" || plain.length === 0) return "Password is required";
  if (plain.length < 12) {
    return "Password must be at least 12 characters";
  }
  if (plain.length > 200) {
    // bcrypt truncates at 72 bytes anyway; the cap just prevents a huge input
    // burning CPU in the hash.
    return "Password must be at most 200 characters";
  }
  const lower = plain.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return "That password is too common — choose something not found on password lists";
  }
  if (username && lower.includes(username.toLowerCase()) && username.length >= 4) {
    return "Password must not contain the username";
  }
  if (/^(.)\1+$/.test(plain)) {
    return "Password must not be a single repeated character";
  }
  // Only a very narrow character set is rejected, and only for shorter entries.
  if (plain.length < 16 && /^[0-9]+$/.test(plain)) {
    return "A digits-only password must be at least 16 characters";
  }
  return null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Loads the session user onto req.user for every protected route. Rejects
 * unauthenticated requests, users whose row vanished, and disabled users.
 */
/**
 * Start an authenticated session for `userId`.
 *
 * MUST be used instead of assigning `req.session.userId` directly, because it
 * regenerates the session ID first. Reusing the pre-login ID is session
 * fixation: anyone who can plant a known session id on a shared or kiosk
 * machine — and then waits for a real user to log in — ends up holding that
 * user's authenticated session. Regenerating issues a fresh, unguessable id at
 * the moment privilege is granted, so the planted one is worthless.
 */
export function establishSession(req: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.loginAt = Date.now();
      // Persist before responding: the client may fire its first authenticated
      // request immediately, and with an async store that can otherwise race.
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    // Absolute cap. Checked server-side rather than trusting cookie expiry,
    // because the client controls the cookie and can replay an old one.
    const loginAt = req.session.loginAt;
    if (typeof loginAt === "number" && Date.now() - loginAt > ABSOLUTE_TIMEOUT_MS) {
      const days = Math.round(ABSOLUTE_TIMEOUT_MS / 86_400_000);
      console.log(
        `🔐 session for user ${req.session.userId} hit the ${days}-day absolute limit — forcing re-login`
      );
      return req.session.destroy(() =>
        res.status(401).json({ error: "Session expired", reason: "absolute_timeout" })
      );
    }

    const user = await storage.getUser(req.session.userId);
    if (!user) {
      // The account was deleted while the session was live.
      req.session.destroy(() => {});
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (user.status === "disabled") {
      // Disabling an account must take effect immediately, not when its 30-day
      // session happens to expire.
      return req.session.destroy(() =>
        res.status(403).json({ error: "Account disabled" })
      );
    }
    req.user = user;
    next();
  } catch (err) {
    console.error("❌ requireAuth failed while loading the session user:", err);
    res.status(500).json({ error: "Auth check failed" });
  }
};
