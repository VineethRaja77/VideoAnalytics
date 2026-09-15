import { QuotaError } from "./quotaWrite";
import type { Express } from "express";
import { createServer, type Server } from "http";
import { spawn } from "child_process";
import { storage, db } from "./storage";
import { sql } from "drizzle-orm";
import { insertCameraSchema } from "@shared/schema";
import { z } from "zod";

import {
  addOrUpdateCameraPath,
  removeCameraPath,
  ensureTranscodePath,
  removeTranscodePath,
  getPathStatus,
  mediamtxPathForCamera,
} from "./mediamtxController";

import {
  startRecorder,
  stopRecorder,
  restartRecorder,
  getRecorderStatus,
  initRecordersFromDB,
  recFolderFor,
  ensureH264Variant,
} from "./recordingWorker";

import { verifyPassword, hashPassword, requireAuth, establishSession, validatePasswordStrength } from "./auth";
import { emitEvent, listEvents } from "./events";
import { requireModule, getLicensedModules } from "./entitlements";
import { canAdd, startQuotaMonitor, usageFor } from "./limits";
import { requireSuperAdmin, requireWriteAccess, requireMinRole, resolveOrgScope } from "./rbac";
import { registerAdminRoutes } from "./adminRoutes";
import { registerSystemRoutes } from "./systemRoutes";
import { registerConsoleRoutes } from "./consoleRoutes";
import { registerOrgRoutes } from "./orgRoutes";
import { registerLicenseRoutes } from "./licenseRoutes";
import { loginLimiter } from "./security";
import { registerSnapshotRoutes, startSnapshotRetention } from "./snapshotRoutes";
import { registerCameraFrameRoutes } from "./cameraFrameRoutes";
import { registerFaceRoutes } from "./faceRoutes";
import { logModelStatus } from "./modelRegistry";
import { startStorageMonitor, checkDisk } from "./storageMonitor";
import { audit, listAudit, purgeExpiredAudit } from "./audit";
import { registerSensorRoutes } from "./sensorRoutes";
import { registerLocationRoutes } from "./locationRoutes";
import { startSensorMqtt } from "./sensorMqtt";
import { registerCameraAnalyticsRoutes } from "./cameraAnalyticsRoutes";
import { initAnalyticsWorkersFromDB } from "./analyticsWorker";
import { registerAnalyticsRoutes } from "./analyticsRoutes";
import type { Request } from "express";
import type { Camera } from "@shared/schema";

import fs from "fs";
import path from "path";

/**
 * Fetch a camera enforcing tenant isolation: super_admin can reach any camera
 * (optionally scoped by ?orgId); a client role can only reach cameras in its
 * own org. Returns undefined when the caller may not access it.
 */
async function getCameraForRequest(req: Request, cameraId: string): Promise<Camera | undefined> {
  if (req.user?.role === "super_admin") return storage.getCamera(cameraId);
  const orgId = req.user?.organizationId;
  if (!orgId) return undefined;
  return storage.getCameraForOrg(cameraId, orgId);
}

const GST_LAUNCH_PATH = process.env.GST_LAUNCH_PATH || "gst-launch-1.0";

async function authPayload(req: Request, user: any) {
  const org = user.organizationId ? await storage.getOrganization(user.organizationId) : null;
  const licensedModules =
    user.role === "super_admin"
      ? "*"
      : user.organizationId
        ? await getLicensedModules(user.organizationId)
        : [];
  return {
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    organizationName: org?.name ?? null,
    organizationLogoDataUrl: (org as any)?.logoDataUrl ?? null,
    licensedModules,
    timezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
    sessionStartedAt: req.session.loginAt ?? null,
  };
}

// SAFE REMOVE FOLDER
function deleteFolderSafe(folderPath: string) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log("🗑 Removed folder:", folderPath);
    }
  } catch (err) {
    console.error("❌ Failed to remove folder:", folderPath, err);
  }
}

/**
 * Probes an RTSP URL with a bounded timeout by actually connecting to it
 * with rtspsrc (forcing TCP, matching the transport recordingWorker.ts
 * uses) and inspecting the negotiated RTP caps for the codec's
 * encoding-name. There is no `gst-discoverer-1.0` binary on Ubuntu's
 * gstreamer1.0-tools package (only gst-inspect/gst-launch/gst-stats/
 * gst-typefind) — this uses gst-launch-1.0, which is actually installed.
 */
function probeStreamCodec(
  streamUrl: string,
  timeoutMs = 8000
): Promise<{ ok: boolean; codec?: "h264" | "h265"; error?: string }> {
  return new Promise((resolve) => {
    const args = ["-v", "rtspsrc", `location=${streamUrl}`, "protocols=tcp", "!", "fakesink"];
    const proc = spawn(GST_LAUNCH_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let settled = false;

    const finish = (result: { ok: boolean; codec?: "h264" | "h265"; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      if (!result.ok) {
        console.error(`❌ test-connection probe failed for ${streamUrl}:\n${output.slice(-2000)}`);
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for the camera to respond (check IP/port/network reachability)" });
    }, timeoutMs);

    // Resolve as soon as we see the codec in the negotiated caps — no need
    // to wait out the full timeout once we already have an answer. gst-launch
    // -v prints "caps =" pad notifications to STDOUT; only warnings/errors
    // go to stderr, so both streams must be checked here.
    const checkOutput = () => {
      if (/encoding-name=\(string\)H265|encoding-name=\(string\)HEVC/i.test(output)) {
        finish({ ok: true, codec: "h265" });
      } else if (/encoding-name=\(string\)H264/i.test(output)) {
        finish({ ok: true, codec: "h264" });
      } else if (/401 Unauthorized|Not Authorized/i.test(output)) {
        finish({ ok: false, error: "Camera rejected the username/password" });
      } else if (/404 Not Found/i.test(output)) {
        finish({ ok: false, error: "Camera reachable, but the stream path (channel/subtype) was not found" });
      }
    };

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      checkOutput();
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
      checkOutput();
    });

    proc.on("error", (err) => {
      finish({ ok: false, error: `Failed to start probe process: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (!settled) {
        finish({ ok: false, error: `Camera connection closed before a codec could be detected (exit code ${code})` });
      }
    });
  });
}

export async function registerRoutes(app: Express, options: { startBackgroundServices?: boolean } = {}): Promise<Server> {
  /* --------------------------
     NO EDGE CACHING FOR THE API
     Every /api response is authenticated and tenant-private. Without this,
     a CDN (Cloudflare auto-caches .mp4 URLs for hours) would serve one
     tenant's recordings/data to anyone with the URL, bypassing auth entirely.
     `private, no-store` tells any cache never to store these responses.
  --------------------------- */
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  /* --------------------------
     AUTH
  --------------------------- */
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    try {
      // Accepts email or username in the same field (email is the primary
      // login now; username kept for backward compatibility).
      const login = req.body.email ?? req.body.username;
      const { password } = req.body;
      const user = login ? await storage.getUserByLogin(String(login)) : undefined;

      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        // Recorded so a brute-force attempt is visible in the trail. The
        // attempted login name is kept (it is not a secret and is the only way
        // to tell "wrong password" from "spraying usernames"); the password is
        // never touched.
        void audit(req, {
          action: "login_failed",
          outcome: "denied",
          organizationId: user?.organizationId ?? null,
          actor: { id: user?.id ?? null, username: String(login ?? "").slice(0, 100), role: user?.role ?? null },
          detail: { reason: user ? "bad_password" : "unknown_account" },
        });
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (user.status === "disabled") {
        void audit(req, {
          action: "login_failed",
          outcome: "denied",
          organizationId: user.organizationId,
          actor: { id: user.id, username: user.username, role: user.role },
          detail: { reason: "account_disabled" },
        });
        return res.status(403).json({ error: "Account disabled" });
      }

      // Regenerates the session id first — see establishSession. Assigning
      // req.session.userId directly would leave the pre-login id valid and
      // reintroduce session fixation.
      //
      // `remember` decides whether the cookie survives the browser closing.
      // Default TRUE so an older client that does not send the field keeps the
      // behaviour it has today; the login screen always sends it explicitly.
      await establishSession(req, user.id, req.body.remember !== false);

      void audit(req, {
        action: "login",
        organizationId: user.organizationId,
        actor: { id: user.id, username: user.username, role: user.role },
      });
      res.json({
        success: true,
        user: await authPayload(req, user),
      });
    } catch (err) {
      console.error("❌ POST /api/auth/login failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    // Captured before destroy() — the session is gone by the time it returns.
    const user = req.user;
    if (user) {
      void audit(req, {
        action: "logout",
        organizationId: user.organizationId,
        actor: { id: user.id, username: user.username, role: user.role },
      });
    }
    req.session.destroy(() => res.json({ success: true }));
  });

  /**
   * Current identity.
   *
   * The client polls this so a tab can notice that a DIFFERENT user signed in
   * from another tab of the same browser. Cookies are per browser profile, not
   * per tab, so a second login silently rebinds every open tab — without this
   * an admin's dashboard would keep rendering admin data under an employee
   * session. `sessionStartedAt` distinguishes a genuine re-login by the same
   * person from an uninterrupted session.
   */
  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const user = req.user!;
    res.json(await authPayload(req, user));
  });

  app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Both current and new password are required" });
      }
      const user = await storage.getUser(req.session.userId!);
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        void audit(req, {
          action: "login_failed",
          outcome: "denied",
          organizationId: user?.organizationId ?? null,
          detail: { reason: "wrong_current_password_on_change" },
        });
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      // Was an 8-character minimum here while admin-set passwords required 12 —
      // a user could self-downgrade below the policy. One rule, one place.
      const weak = validatePasswordStrength(String(newPassword), user.username);
      if (weak) return res.status(400).json({ error: weak });

      await storage.updateUserPasswordHash(user.id, await hashPassword(newPassword));

      // A password change must invalidate the OLD session id: if the reason for
      // changing it was "someone may have my session", keeping that id alive
      // defeats the point. The user stays logged in on THIS device.
      await establishSession(req, user.id);

      void audit(req, {
        action: "password_changed",
        organizationId: user.organizationId,
        targetType: "user",
        targetId: user.id,
        targetLabel: user.username,
        detail: { selfService: true },
      });
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Change password failed:", err);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  /* --------------------------
     PLATFORM APIs
     Super-admin console + client-admin org management.
  --------------------------- */
  app.use("/api/admin", requireAuth, requireSuperAdmin);
  registerAdminRoutes(app);
  registerSystemRoutes(app);
  registerConsoleRoutes(app);
  app.use("/api/org", requireAuth);
  registerOrgRoutes(app);
  // Public licensing endpoints (fingerprint + phone-home) — no session auth.
  registerLicenseRoutes(app);
  // Analytics events: worker ingest (key-authed) + dashboard read (session).
  registerAnalyticsRoutes(app);
  registerCameraAnalyticsRoutes(app);
  /**
   * What this organisation is using, against what it is allowed.
   *
   * Client-facing: a client admin should be able to see they are at 218 of 250
   * cameras WITHOUT being refused first. Being told a limit exists only at the
   * moment it blocks you is how a limit feels arbitrary.
   */
  app.get("/api/org/usage", requireAuth, async (req, res) => {
    const orgId = resolveOrgScope(req);
    if (!orgId) return res.status(400).json({ error: "No organization context" });
    try {
      res.json(await usageFor(orgId));
    } catch (err) {
      console.error("❌ GET /api/org/usage failed:", err);
      res.status(500).json({ error: "Failed to read usage" });
    }
  });

  registerSnapshotRoutes(app);
  // A live still from a camera — the backdrop an operator draws zones on.
  registerCameraFrameRoutes(app);
  // Enrol / list / remove the people face recognition matches against.
  registerFaceRoutes(app);

  /* --------------------------
     VMS MODULE — requires a session AND a valid 'vms' license for the org.
     requireModule('vms') 403s if the org's license is missing/suspended/expired
     (super_admin bypasses). Write actions additionally require manager+.
  --------------------------- */
  app.use("/api/cameras", requireAuth, requireModule("vms"));
  app.use("/api/streams", requireAuth, requireModule("vms"));
  app.use("/api/recordings", requireAuth, requireModule("vms"));
  app.use("/api/export", requireAuth, requireModule("vms"));
  app.use("/api/webrtc-config", requireAuth, requireModule("vms"));
  app.use("/api/notifications", requireAuth);

  /* --------------------------
     NOTIFICATIONS
  --------------------------- */
  /**
   * Liveness + readiness for systemd, a load balancer or an uptime monitor.
   *
   * UNAUTHENTICATED ON PURPOSE — a health check that needs a session is useless
   * to the thing that has to restart the service. It therefore leaks nothing:
   * no version, no hostname, no camera or tenant data. Just whether the two
   * dependencies the app cannot work without are reachable.
   *
   * 200 = serving traffic. 503 = do not send traffic here.
   */
  app.get("/api/health", async (_req, res) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await db.execute(sql`select 1`);
      checks.database = "ok";
    } catch (err) {
      checks.database = "unreachable";
      healthy = false;
      console.error("❌ health check: database unreachable:", err);
    }

    try {
      const disk = await checkDisk();
      checks.storage = disk.level;
      // Critical disk means writes are about to fail; report unhealthy so an
      // orchestrator stops routing new work here before recording breaks.
      if (disk.level === "critical") healthy = false;
    } catch (err) {
      checks.storage = "unknown";
      console.error("❌ health check: could not read disk status:", err);
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      checks,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/api/system/storage", requireAuth, async (_req, res) => {
    try {
      res.json(await checkDisk());
    } catch (err) {
      console.error("❌ /api/system/storage failed:", err);
      res.status(500).json({ error: "Could not read disk status" });
    }
  });

  // The trail is readable by client_admin and above. A client_manager can
  // change things but must not be able to review who else did what — that is an
  // admin function, and letting the audited read the audit weakens it.
  app.get("/api/audit", requireAuth, requireMinRole("client_admin"), async (req, res) => {
    try {
      const rows = await listAudit({
        organizationId: resolveOrgScope(req),
        isSuperAdmin: req.user?.role === "super_admin",
        action: (req.query.action as string) || undefined,
        actorId: (req.query.actorId as string) || undefined,
        from: req.query.from ? new Date(String(req.query.from)) : undefined,
        to: req.query.to ? new Date(String(req.query.to)) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(rows);
    } catch (err) {
      console.error("❌ GET /api/audit failed:", err);
      res.status(500).json({ error: "Failed to read audit log" });
    }
  });

  app.get("/api/notifications", (req, res) => {
    // Scoped: these messages embed camera names, so an unscoped list would
    // disclose another client's site layout and infrastructure health.
    const orgId = resolveOrgScope(req);
    res.json(listEvents(orgId, req.user?.role === "super_admin"));
  });

  /* --------------------------
     CAMERA CRUD
  --------------------------- */

  app.get("/api/cameras", async (req, res) => {
    try {
      // Tenant scoping: client roles see only their org; super_admin sees all
      // (or a specific org via ?orgId).
      let cams;
      if (req.user!.role === "super_admin") {
        const orgId = req.query.orgId as string | undefined;
        cams = orgId ? await storage.getCamerasByOrg(orgId) : await storage.getAllCameras();
      } else {
        cams = await storage.getCamerasByOrg(req.user!.organizationId!);
      }

      const camsWithStatus = cams.map((cam) => {
        const rec = getRecorderStatus(cam.id);
        return { ...cam, status: rec.running ? "online" : "inactive", isStreaming: rec.running };
      });

      res.json(camsWithStatus);
    } catch (err) {
      console.error("❌ GET /api/cameras failed:", err);
      res.status(500).json({ error: "Failed to fetch cameras" });
    }
  });

  app.get("/api/cameras/:id", async (req, res) => {
    try {
      const cam = await getCameraForRequest(req, req.params.id);
      if (!cam) return res.status(404).json({ error: "Camera not found" });

      const rec = getRecorderStatus(cam.id);
      res.json({ ...cam, status: rec.running ? "online" : "inactive", isStreaming: rec.running });
    } catch (err) {
      console.error("❌ GET /api/cameras/:id failed:", err);
      res.status(500).json({ error: "Failed to fetch camera" });
    }
  });

  app.post("/api/cameras/test-connection", requireWriteAccess, async (req, res) => {
    try {
      const { streamUrl } = req.body;
      if (!streamUrl) return res.status(400).json({ error: "streamUrl is required" });

      const result = await probeStreamCodec(streamUrl);
      if (!result.ok) return res.json({ ok: false, error: result.error || "Could not connect to camera" });

      res.json({ ok: true, detectedCodec: result.codec || "h264" });
    } catch (err) {
      console.error("❌ POST /api/cameras/test-connection failed:", err);
      res.status(500).json({ error: "Failed to test connection" });
    }
  });

  app.post("/api/cameras", requireWriteAccess, async (req, res) => {
    try {
      const validated = insertCameraSchema.parse(req.body);

      // Determine the owning org (client roles: their own; super_admin: ?orgId/body).
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context for this camera" });

      // Every quota is decided in one place (server/limits.ts) so the number a
      // client is refused on is the same number the console shows them.
      const allowed = await canAdd(orgId, "maxCameras");
      if (!allowed.ok) return res.status(403).json({ error: allowed.message });

      const camera = await storage.createCamera(validated, orgId);

      console.log("📸 New camera added:", camera.id);
      emitEvent("camera_added", `Camera "${camera.name}" was added`, camera);
      void audit(req, {
        action: "camera_created",
        organizationId: orgId,
        targetType: "camera",
        targetId: camera.id,
        targetLabel: camera.name,
        // scrubDetail drops streamUrl/password; what is kept is the
        // non-sensitive shape of the camera.
        detail: { location: camera.location, videoCodec: camera.videoCodec, ipAddress: camera.ipAddress },
      });

      try {
        await addOrUpdateCameraPath(camera);
        await storage.setRecordingMetadata(camera.id, { mediamtxPath: mediamtxPathForCamera(camera.id) });
        startRecorder(camera);
      } catch (err) {
        console.error("❌ Failed to start camera pipeline:", err);
      }

      res.status(201).json(camera);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid camera data", details: err.errors });
      }
      if (err instanceof QuotaError) return res.status(403).json({ error: err.message });
      console.error("❌ POST /api/cameras failed:", err);
      res.status(500).json({ error: "Failed to create camera" });
    }
  });

  app.patch("/api/cameras/:id", requireWriteAccess, async (req, res) => {
    try {
      const existing = await getCameraForRequest(req, req.params.id);
      if (!existing) return res.status(404).json({ error: "Camera not found" });

      const updateData: any = {
        name: req.body.name ?? existing.name,
        channelId: req.body.channelId ?? existing.channelId,
        streamUrl: req.body.streamUrl ?? existing.streamUrl,
        streamType: req.body.streamType ?? existing.streamType,
        videoCodec: req.body.videoCodec ?? existing.videoCodec,
        ipAddress: req.body.ipAddress ?? existing.ipAddress,
        username: req.body.username ?? existing.username,
        password: req.body.password ?? existing.password,
        location: req.body.location ?? existing.location,
        recordingPolicy: req.body.recordingPolicy ?? existing.recordingPolicy,
        status: req.body.status ?? existing.status,
        port: req.body.port ?? existing.port,
        vendor: req.body.vendor ?? existing.vendor,
        streamMode: req.body.streamMode ?? existing.streamMode,
        recordingEnabled: req.body.recordingEnabled ?? existing.recordingEnabled,
      };

      const updated = await storage.updateCamera(req.params.id, updateData);
      console.log("📝 Camera updated:", req.params.id);
      // Record which fields changed, not their values: a stream URL carries the
      // camera password inline, so "streamUrl changed" is the auditable fact.
      const changed = Object.keys(updateData).filter(
        (k) => (updateData as any)[k] !== (existing as any)[k]
      );
      void audit(req, {
        action: "camera_updated",
        organizationId: existing.organizationId,
        targetType: "camera",
        targetId: req.params.id,
        targetLabel: existing.name,
        detail: { changedFields: changed },
      });

      const needsRestart =
        updateData.streamUrl !== existing.streamUrl || updateData.videoCodec !== existing.videoCodec;

      if (updated && needsRestart) {
        console.log("♻ Restarting pipeline after update:", req.params.id);
        try {
          await addOrUpdateCameraPath(updated);
          await restartRecorder(updated);
        } catch (err) {
          console.error("❌ Failed restart:", err);
        }
      }

      res.json(updated);
    } catch (err) {
      console.error("❌ PATCH /api/cameras/:id failed:", err);
      res.status(500).json({ error: "Failed to update camera" });
    }
  });

  app.delete("/api/cameras/:id", requireWriteAccess, async (req, res) => {
    const id = req.params.id;

    console.log("🗑 DELETE camera requested:", id);

    try {
      const cam = await getCameraForRequest(req, id);
      if (!cam) {
        return res.status(404).json({ error: "Camera not found" });
      }

      try {
        await stopRecorder(id);
      } catch (err) {
        console.warn("⚠ stopRecorder error:", err);
      }

      await removeCameraPath(id);
      await removeTranscodePath(id);

      if (cam.recordingFolder) deleteFolderSafe(cam.recordingFolder);

      await storage.deleteCamera(id);
      console.log("✔ Camera deleted:", id);
      emitEvent("camera_removed", `Camera "${cam.name}" was removed`, cam);
      void audit(req, {
        action: "camera_deleted",
        organizationId: cam.organizationId,
        targetType: "camera",
        targetId: id,
        targetLabel: cam.name,
        detail: { recordingsFolderRemoved: !!cam.recordingFolder },
      });

      res.json({ success: true });
    } catch (err) {
      console.error("❌ Delete failed:", err);
      res.status(500).json({ error: "Failed to delete camera" });
    }
  });

  /* --------------------------
     STREAM CONTROL
  --------------------------- */

  app.post("/api/streams/start", requireWriteAccess, async (req, res) => {
    try {
      const camera = await getCameraForRequest(req, req.body.cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      await addOrUpdateCameraPath(camera);
      startRecorder(camera);
      res.json({ success: true });
    } catch (err) {
      console.error("❌ POST /api/streams/start failed:", err);
      res.status(500).json({ error: "Failed to start stream" });
    }
  });

  app.post("/api/streams/stop", requireWriteAccess, async (req, res) => {
    try {
      const camera = await getCameraForRequest(req, req.body.cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });
      await stopRecorder(camera.id);
      await removeCameraPath(camera.id);
      await removeTranscodePath(camera.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to stop stream" });
    }
  });

  app.get("/api/streams/status/:id", async (req, res) => {
    const camera = await getCameraForRequest(req, req.params.id);
    if (!camera) return res.status(404).json({ error: "Camera not found" });
    const rec = getRecorderStatus(camera.id);
    const mtx = await getPathStatus(mediamtxPathForCamera(camera.id));
    res.json({ isStreaming: rec.running, recorder: rec, mediamtx: mtx });
  });

  /* --------------------------
     WEBRTC CONFIG — resolves the correct WHEP path for a camera,
     including on-demand H.265->H.264 transcode activation.
  --------------------------- */
  app.get("/api/webrtc-config/:cameraId", async (req, res) => {
    try {
      const camera = await getCameraForRequest(req, req.params.cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const { needsTranscode } = req.query;
      let whepPath = mediamtxPathForCamera(camera.id);

      if (camera.videoCodec === "h265" && needsTranscode === "true") {
        whepPath = await ensureTranscodePath(camera.id);
      }

      res.json({
        whepPath,
        whepUrl: `/whep/${whepPath}`,
        codec: camera.videoCodec,
        transcodeAvailable: camera.videoCodec === "h265",
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to resolve webrtc config" });
    }
  });

  /* --------------------------
     RECORDINGS - FROM DATABASE
  --------------------------- */
  app.get("/api/cameras/:id/recordings", async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const cameraId = req.params.id;

      // Tenant isolation: only recordings for a camera the caller owns.
      const camera = await getCameraForRequest(req, cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const recordings = await storage.getRecordingsByCamera(
        cameraId,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined
      );

      res.json(recordings);
    } catch (err) {
      console.error("❌ Failed to fetch recordings:", err);
      res.status(500).json({ error: "Failed to fetch recordings" });
    }
  });

  /* --------------------------
     SERVE RECORDING FILE
  --------------------------- */
  // requireAuth is explicit here even though getCameraForRequest already fails
  // closed for anonymous callers: an audit row with no actor is worthless, and
  // 401 is the honest status for "not logged in".
  app.get("/api/recordings/:cameraId/:filename", requireAuth, async (req, res) => {
    try {
      const { cameraId, filename } = req.params;
      if (!/^recording-\d+\.mp4$/.test(filename)) {
        return res.status(400).json({ error: "Invalid recording filename" });
      }

      const camera = await getCameraForRequest(req, cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      let recordingPath = path.join(recFolderFor(camera), filename);

      if (!fs.existsSync(recordingPath)) {
        console.error(`❌ Recording not found: ${recordingPath}`);
        return res.status(404).json({ error: "Recording not found" });
      }

      // "Who watched that footage?" is the question a client will eventually
      // ask, and this is the only place that can answer it. Logged on every
      // served range request; the UI seeking through a clip produces several
      // rows for one viewing, which is noisy but truthful.
      void audit(req, {
        action: "recording_viewed",
        organizationId: camera.organizationId,
        targetType: "recording",
        targetId: `${cameraId}/${filename}`,
        targetLabel: camera.name,
        detail: { range: req.header("range") ?? null, codec: req.query.codec ?? null },
      });

      // H.264 compatibility variant for H.265 recordings (browsers/players
      // without an HEVC decoder). Transcoded once on first request, cached.
      if (req.query.codec === "h264" && camera.videoCodec === "h265") {
        const variant = await ensureH264Variant(recordingPath);
        if (!variant) return res.status(500).json({ error: "Failed to prepare H.264 playback variant" });
        recordingPath = variant;
      }

      const stat = fs.statSync(recordingPath);

      // Honor Range requests — browsers require real 206 partial-content
      // responses for reliable <video> playback and seeking; advertising
      // Accept-Ranges while returning the whole file breaks both.
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (match[1] === "" && match[2] === "")) {
          return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
        }
        const start = match[1] === "" ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
        const end = match[1] !== "" && match[2] !== "" ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start >= stat.size || start > end) {
          return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
        }

        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(recordingPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });

      const readStream = fs.createReadStream(recordingPath);
      readStream.pipe(res);
    } catch (err) {
      console.error("❌ Error serving recording:", err);
      res.status(500).json({ error: "Failed to serve recording" });
    }
  });

  /* --------------------------
     EXPORT/DOWNLOAD RECORDING
  --------------------------- */
  app.get("/api/export/:cameraId/:filename", async (req, res) => {
    try {
      const { cameraId, filename } = req.params;
      if (!/^recording-\d+\.mp4$/.test(filename)) {
        return res.status(400).json({ error: "Invalid recording filename" });
      }

      const camera = await getCameraForRequest(req, cameraId);
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      let recordingPath = path.join(recFolderFor(camera), filename);

      if (!fs.existsSync(recordingPath)) {
        return res.status(404).json({ error: "Recording not found" });
      }

      // Exports must play on any client machine in any player — H.265
      // originals are converted to universally-playable H.264 (once, cached).
      if (camera.videoCodec === "h265") {
        const variant = await ensureH264Variant(recordingPath);
        if (!variant) return res.status(500).json({ error: "Failed to prepare export" });
        recordingPath = variant;
      }

      const stat = fs.statSync(recordingPath);

      const record = await storage.getRecordingByFilePath(cameraId, filename);
      const cameraName = camera.name.replace(/[^a-z0-9]/gi, "_");
      let downloadName = filename;

      if (record) {
        const start = new Date(record.startTime);
        const pad = (n: number) => String(n).padStart(2, "0");
        downloadName = `${cameraName}_${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(
          start.getUTCDate()
        )}_${pad(start.getUTCHours())}${pad(start.getUTCMinutes())}.mp4`;
      }

      console.log(`📥 Exporting: ${downloadName}`);

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${downloadName}"`,
      });

      const readStream = fs.createReadStream(recordingPath);
      readStream.pipe(res);
    } catch (err) {
      console.error("❌ Export error:", err);
      res.status(500).json({ error: "Failed to export recording" });
    }
  });

  /* --------------------------
     PIPELINE RESTORE ON BOOT
  --------------------------- */

  const httpServer = createServer(app);
  registerLocationRoutes(app);
  registerSensorRoutes(app);
  // Integration/browser harnesses exercise real routes without starting media workers.
  if (options.startBackgroundServices === false) return httpServer;

  initRecordersFromDB().catch((err) => console.error("❌ Failed to restore recorders:", err));
  startSensorMqtt();   // no-op unless MQTT_URL is set

  logModelStatus();
  startStorageMonitor();
  // Per-CLIENT allowances, as opposed to the host's own disk.
  startQuotaMonitor();

  // Audit retention: off unless the operator sets AUDIT_RETENTION_DAYS, and
  // floored at 365 days when they do. Runs daily, not hourly — this is a slow
  // table and there is nothing urgent about it.
  void purgeExpiredAudit().catch((err) =>
    console.error("❌ initial audit purge failed:", err)
  );
  setInterval(
    () =>
      void purgeExpiredAudit().catch((err) =>
        console.error("❌ scheduled audit purge failed:", err)
      ),
    24 * 60 * 60 * 1000
  );
  startSnapshotRetention();
  initAnalyticsWorkersFromDB().catch((err) =>
    console.error("❌ Failed to restore analytics workers:", err)
  );

  return httpServer;
}
