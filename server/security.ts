// server/security.ts
//
// Baseline HTTP hardening. None of this existed before: no security headers,
// and no brute-force protection on login — an on-prem box exposed to a client
// network could be password-sprayed indefinitely.
//
// Two deliberate carve-outs, both about not breaking media:
//   * CSP is off. The app serves a Vite bundle and proxies MediaMTX WHEP/HLS;
//     a wrong policy silently breaks live video, which is worse than no policy
//     on a single-origin app that has no user-supplied HTML.
//   * COEP/CORP are off for the same reason — they block cross-origin media.

import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { Express, RequestHandler } from "express";

export function applySecurityHeaders(app: Express): void {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      // HSTS only makes sense once TLS terminates at nginx in production.
      hsts: process.env.NODE_ENV === "production",
    })
  );
}

/**
 * Login brute-force limiter: 10 attempts per IP per 15 min.
 *
 * Keyed on IP + submitted identifier so one attacker cannot lock out every
 * user from a shared NAT by hammering a single account, and successful logins
 * do not count toward the limit.
 */
export const loginLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const who = String(req.body?.email ?? req.body?.username ?? "").toLowerCase();
    return `${req.ip}|${who}`;
  },
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

/**
 * Ingest limiter. Workers post at a low rate (an event per crossing/violation,
 * not per frame), so this is generous enough to never throttle a healthy worker
 * while bounding damage from a stolen token.
 */
export const ingestLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${req.header("X-Ingest-Key")?.slice(0, 12) ?? ""}`,
  message: { error: "Ingest rate limit exceeded" },
});

/**
 * Origin check for state-changing requests — CSRF defence in depth.
 *
 * `SameSite=lax` already blocks a cross-SITE POST from carrying the session
 * cookie, and that is the primary defence. It is not sufficient here for one
 * specific reason: SameSite compares the REGISTRABLE DOMAIN, so every host
 * under the same parent is "same-site". A deployment that serves the VMS at
 * vms.example.com alongside anything else at another subdomain — an annotation
 * tool, a wiki, a staging app — gets no SameSite protection between them. An
 * XSS or a hostile upload on the neighbouring subdomain could then drive
 * authenticated state changes here: delete cameras, add users, revoke licences.
 *
 * So: any request that changes state must carry an Origin (or Referer) that is
 * explicitly allowed. Browsers always send Origin on cross-origin requests and
 * on all POST/PUT/PATCH/DELETE, so a real user is never blocked.
 *
 * Configure with ALLOWED_ORIGINS (comma-separated). When unset, same-host
 * requests are accepted, which is the normal single-origin on-prem install.
 */
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  // Safe methods do not change state; HEAD/OPTIONS must stay unauthenticated-safe.
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  // Worker ingest is machine-to-machine with a bearer key and no cookie, so it
  // is not a CSRF target — a browser cannot be tricked into supplying the key.
  // NOTE: this middleware is mounted at "/api", and Express strips the mount
  // path from req.path. Matching the full "/api/analytics/events" here would
  // never fire and every worker would be rejected. req.originalUrl keeps the
  // prefix, so both mounted and unmounted use work.
  if (req.originalUrl.split("?")[0].endsWith("/analytics/events") && req.header("X-Ingest-Key")) {
    return next();
  }

  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const origin = req.header("origin");
  const referer = req.header("referer");

  // No Origin AND no Referer: not a browser (curl, a worker, a health probe).
  // Those carry no ambient cookie authority, so there is nothing to forge.
  if (!origin && !referer) return next();

  const candidate = origin ?? (() => {
    try { return new URL(referer!).origin; } catch { return null; }
  })();
  if (!candidate) {
    console.warn(`⛔ CSRF: unparseable Referer "${referer}" on ${req.method} ${req.path}`);
    return res.status(403).json({ error: "Request origin could not be verified" });
  }

  if (allowed.length) {
    if (allowed.includes(candidate)) return next();
  } else {
    // Default: accept only this exact host. Covers the standard install where
    // the UI and API are served from one origin.
    const host = req.header("host");
    if (host) {
      try {
        if (new URL(candidate).host === host) return next();
      } catch { /* fall through to the rejection below */ }
    }
  }

  console.warn(
    `⛔ CSRF: rejected ${req.method} ${req.path} from origin "${candidate}" ` +
      `(host="${req.header("host")}"). If this is a legitimate deployment, add it to ALLOWED_ORIGINS.`
  );
  return res.status(403).json({
    error: "Request origin not allowed",
    hint: "Set ALLOWED_ORIGINS if the UI is served from a different host than the API.",
  });
};

/** General API limiter — a backstop against scraping/enumeration. */
export const apiLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Media paths are proxied elsewhere; this only guards /api.
  skip: (req) => !req.path.startsWith("/api"),
});
