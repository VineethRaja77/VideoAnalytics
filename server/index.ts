import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./serve";
import { setupSession } from "./auth";
import { seedPlatform } from "./seed";
import { assertSchemaCurrent, assertConfigUsable } from "./schemaCheck";
import { initLicensing } from "./licenseClient";
import { applySecurityHeaders, apiLimiter, requireSameOrigin } from "./security";
import { FACE_BODY_LIMIT } from "./faceRoutes";

const app = express();

// Trust nginx (the immediate reverse proxy) so req.secure / X-Forwarded-Proto
// are honored correctly — required for express-session's `cookie.secure`
// to work when NODE_ENV=production, since TLS is terminated at nginx and
// forwarded to this app over plain HTTP.
app.set("trust proxy", 1);

// Security headers + API rate limiting, before anything that handles input.
applySecurityHeaders(app);
app.use(apiLimiter);

/* -----------------------------------------------
   SESSIONS — must be mounted before any route that
   reads req.session (registerRoutes, below).
------------------------------------------------ */
setupSession(app);

/* -----------------------------------------------
   CSRF: verify the origin of every state-changing
   request. Mounted AFTER the session so it protects
   cookie-authenticated routes, and before any handler
   that mutates data.
------------------------------------------------ */
app.use("/api", requireSameOrigin);

/* -----------------------------------------------
   MEDIAMTX PROXY — WebRTC (WHEP) + HLS live delivery.
   MediaMTX serves media directly; Express just forwards
   so the frontend only ever talks to one origin (avoids
   CORS/cookie headaches behind a real domain later).
------------------------------------------------ */
const MTX_WEBRTC_PORT = process.env.MTX_WEBRTC_PORT || "8889";
const MTX_HLS_PORT = process.env.MTX_HLS_PORT || "8888";

// Browser-facing convention is /whep/{mediamtxPath}; MediaMTX itself expects
// /{mediamtxPath}/whep (confirmed against the installed MediaMTX version —
// a GET to /{path}/whep returns 405, not 404, meaning that's the real route).
app.use(
  "/whep",
  createProxyMiddleware({
    target: `http://127.0.0.1:${MTX_WEBRTC_PORT}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: (path) => {
      // Handles both cases: Express may or may not have stripped the /whep mount prefix already.
      const stripped = path.replace(/^\/whep\//, "/");
      return stripped.replace(/^\/(.+)$/, "/$1/whep");
    },
  })
);

app.use(
  "/hls-live",
  createProxyMiddleware({
    target: `http://127.0.0.1:${MTX_HLS_PORT}`,
    changeOrigin: true,
    pathRewrite: { "^/hls-live": "" },
  })
);

/* -----------------------------------------------
   RAW BODY SUPPORT
------------------------------------------------ */
declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

/* Face enrolment carries photographs, so its body is far larger than anything
   else in the product. The bigger limit is applied to THAT ROUTE ONLY: raising
   the global limit would let any endpoint — including unauthenticated ones — be
   used to make the server allocate megabytes per request. */
const captureRawBody = (req: any, _res: any, buf: Buffer) => {
  req.rawBody = buf;
};
const standardJson = express.json({ verify: captureRawBody });
const largeJson = express.json({ limit: FACE_BODY_LIMIT, verify: captureRawBody });
const LARGE_BODY_PATHS = [/^\/api\/face\/people\/?$/];

app.use((req, res, next) =>
  (LARGE_BODY_PATHS.some((re) => re.test(req.path)) ? largeJson : standardJson)(
    req,
    res,
    next
  )
);

app.use(express.urlencoded({ extended: false }));

/* -----------------------------------------------
   API LOGGING
------------------------------------------------ */
app.use((req, res, next) => {
  const start = Date.now();

  const originalJson = res.json;
  res.json = function (body, ...args) {
    return originalJson.apply(res, [body, ...args]);
  };

  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      log(`${req.method} ${req.path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });

  next();
});

/* -----------------------------------------------
   ROUTES + VITE + SERVER START
------------------------------------------------ */
(async () => {
  // BEFORE anything else touches the database. Seeding and worker restore both
  // fail with errors that never mention the schema, so drift must be reported
  // here or it gets misdiagnosed for hours.
  assertConfigUsable();
  await assertSchemaCurrent();

  await initLicensing();
  await seedPlatform();
  const server = await registerRoutes(app);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("❌ GLOBAL ERROR:", err);
    return res.status(err.status || 500).json({
      message: err.message || "Internal Server Error",
    });
  });

  // Vite must come LAST. The dev integration is imported dynamically so the
  // production bundle never includes it (keeps the bytecode build CJS-clean).
  if (app.get("env") === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT || "5002", 10);

  server.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`\n🚀 Server running on port ${port}`);
    console.log(`🎥 WHEP live proxy: http://localhost:${port}/whep/{mediamtxPath}\n`);
  });
})();
