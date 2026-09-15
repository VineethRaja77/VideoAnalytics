// server/cameraFrameRoutes.ts
//
// A single still frame from a live camera.
//
//   GET /api/cameras/:id/frame   authenticated, org-scoped, JPEG
//
// WHY THIS IS NOT THE EXISTING SNAPSHOT ROUTE
//   /api/analytics/events/:id/snapshot serves an image an AI worker already
//   saved to disk. This one goes to the camera NOW, because the operator needs
//   to see what the lens sees in order to draw an intrusion zone over it.
//
// COORDINATE CONTRACT — the reason this route exists at all
//   Zone polygons are stored in the analytics worker's IMAGE PIXEL space. The
//   worker opens the stream with cv2.VideoCapture and never resizes, and so
//   does scripts/grab_frame.py, so a point clicked on this JPEG maps 1:1 onto
//   the frame the rule is evaluated against. The natural width/height are
//   returned in headers so the browser can convert from displayed pixels.
//
// COST CONTROL
//   Each miss spawns a process that opens an RTSP session. Two guards:
//     - a short-lived cache, so a page with several previews or a user clicking
//       "refresh" repeatedly does not open a session per click;
//     - in-flight de-duplication, so ten concurrent requests for one camera
//       produce ONE grab rather than ten competing RTSP connections.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Express, Request } from "express";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { resolveOrgScope } from "./rbac";
import { mediamtxPathForCamera } from "./mediamtxController";

const MTX_HOST = process.env.MTX_HOST || "127.0.0.1";
const MTX_RTSP_PORT = process.env.MTX_RTSP_PORT || "8554";

/** How long a grabbed frame stays good enough to re-serve. */
const CACHE_MS = Number(process.env.CAMERA_FRAME_CACHE_MS || 5_000);
/** Hard ceiling on the grab. An unreachable camera must not hold a request open. */
const GRAB_TIMEOUT_MS = Number(process.env.CAMERA_FRAME_TIMEOUT_MS || 20_000);

interface CachedFrame {
  buf: Buffer;
  width: number;
  height: number;
  at: number;
}

const cache = new Map<string, CachedFrame>();
const inFlight = new Map<string, Promise<CachedFrame>>();

/**
 * A python that has opencv. The analytics modules each own a venv; any of them
 * will do, since all that is needed is cv2. Falling back to the system python
 * is deliberate — it produces a clear "No module named cv2" rather than a
 * silent failure — but the module venvs are tried first because that is where
 * opencv is actually installed on a deployed box.
 */
function grabberPython(): string {
  const base = process.env.MODELS_BASE || path.join(process.cwd(), "models");
  for (const mod of ["person", "face", "vehicle", "ppe"]) {
    const py = path.join(base, mod, ".venv", "bin", "python");
    if (fs.existsSync(py)) return py;
  }
  return process.env.PYTHON_BIN || "python3";
}

function grabScript(): string {
  return path.join(process.cwd(), "scripts", "grab_frame.py");
}

class GrabError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** Run the grabber once and return the JPEG plus its true pixel size. */
function grabFrame(cameraId: string, rtsp: string): Promise<CachedFrame> {
  return new Promise((resolve, reject) => {
    const outFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vms-frame-")),
      "frame.jpg"
    );
    const cleanup = () => {
      try {
        fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };

    const proc = spawn(grabberPython(), [grabScript()], {
      // The URL travels in the environment, never argv: argv is world-readable
      // through /proc and an RTSP URL can carry the camera password.
      env: { ...process.env, GRAB_RTSP: rtsp, GRAB_OUT: outFile },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      cleanup();
      reject(
        new GrabError(
          `Camera did not deliver a frame within ${Math.round(
            GRAB_TIMEOUT_MS / 1000
          )}s. The stream is unreachable or too slow to connect.`,
          504
        )
      );
    }, GRAB_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(
        new GrabError(
          `Could not run the frame grabber (${err.message}). The analytics ` +
            `Python environment is missing on this server.`,
          500
        )
      );
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        cleanup();
        // Pass the grabber's OWN reason through. It distinguishes "could not
        // open" from "opened but produced no frame", which is the difference
        // between a network problem and a codec problem.
        const reason = stderr.trim().split("\n").filter(Boolean).pop();
        return reject(new GrabError(reason || `Frame grab failed (exit ${code}).`));
      }
      try {
        const buf = fs.readFileSync(outFile);
        let width = 0;
        let height = 0;
        try {
          const meta = JSON.parse(stdout.trim().split("\n").pop() || "{}");
          width = Number(meta.width) || 0;
          height = Number(meta.height) || 0;
        } catch {
          /* dimensions are a convenience; the browser can read them itself */
        }
        resolve({ buf, width, height, at: Date.now() });
      } catch (err) {
        reject(new GrabError(`Frame grabber reported success but wrote no file.`));
      } finally {
        cleanup();
      }
    });
  });
}

/** Cached + de-duplicated access to a camera's current frame. */
async function currentFrame(cameraId: string, rtsp: string, force: boolean) {
  const hit = cache.get(cameraId);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;

  const running = inFlight.get(cameraId);
  if (running) return running;

  const p = grabFrame(cameraId, rtsp)
    .then((frame) => {
      cache.set(cameraId, frame);
      return frame;
    })
    .finally(() => inFlight.delete(cameraId));

  inFlight.set(cameraId, p);
  return p;
}

async function cameraForRequest(req: Request, id: string) {
  const orgId = resolveOrgScope(req);
  if (!orgId && req.user?.role !== "super_admin") return null;
  return req.user?.role === "super_admin"
    ? await storage.getCamera(id)
    : await storage.getCameraForOrg(id, orgId!);
}

export function registerCameraFrameRoutes(app: Express): void {
  app.get("/api/cameras/:id/frame", requireAuth, async (req, res) => {
    try {
      const camera = await cameraForRequest(req, req.params.id);
      // 404 rather than 403 for a camera in another tenant — never confirm
      // that an id exists somewhere else.
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      // Read through MediaMTX, not the camera directly. MediaMTX already holds
      // exactly one session per camera; dialling the camera again would use a
      // second of its (often 2-4) concurrent connection slots and can knock the
      // recorder off a cheap NVR.
      const rtsp = `rtsp://${MTX_HOST}:${MTX_RTSP_PORT}/${mediamtxPathForCamera(camera.id)}`;

      const frame = await currentFrame(camera.id, rtsp, req.query.refresh === "1");

      if (frame.width) res.setHeader("X-Frame-Width", String(frame.width));
      if (frame.height) res.setHeader("X-Frame-Height", String(frame.height));
      // private: this is live footage of one tenant's site.
      res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
      res.setHeader("Content-Type", "image/jpeg");
      res.send(frame.buf);
    } catch (err) {
      const status = err instanceof GrabError ? err.status : 500;
      const message =
        err instanceof GrabError
          ? err.message
          : "Unexpected error while capturing a frame.";
      console.error(`❌ camera frame ${req.params.id}: ${message}`);
      res.status(status).json({ error: message });
    }
  });
}

/** Test seam: drop cached frames (also used when a camera is deleted). */
export function clearFrameCache(cameraId?: string): void {
  if (cameraId) cache.delete(cameraId);
  else cache.clear();
}
