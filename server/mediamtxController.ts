// server/mediamtxController.ts
//
// Owns MediaMTX path lifecycle via its HTTP Control API. MediaMTX is the
// single, centralized live-video server: it pulls each camera's RTSP stream
// exactly once and natively re-serves it as WebRTC (WHEP) and LL-HLS.
// GStreamer never talks to a camera directly — it consumes MediaMTX's
// re-published RTSP output instead (see recordingWorker.ts).

import type { Camera } from "@shared/schema";
import { detectGpuVendor, type GpuVendor } from "./gstCapabilities";

const MTX_API_BASE = process.env.MTX_API_BASE || "http://127.0.0.1:9997";
const MTX_RTSP_PORT = process.env.MTX_RTSP_PORT || "8554";
const GST_LAUNCH_PATH = process.env.GST_LAUNCH_PATH || "gst-launch-1.0";

export function mediamtxPathForCamera(cameraId: string): string {
  return `cam_${cameraId.replace(/-/g, "")}`;
}

export function transcodePathForCamera(cameraId: string): string {
  return `${mediamtxPathForCamera(cameraId)}_h264`;
}

interface MtxError {
  error?: string;
}

async function mtxRequest(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MTX_API_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(2500),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err: MtxError = parsed;
    throw new Error(`MediaMTX API ${method} ${path} failed (${res.status}): ${err.error || text}`);
  }
  return parsed;
}

/** Always-pulling ingest path for a camera — recording must not depend on viewer count. */
export async function addOrUpdateCameraPath(camera: Camera): Promise<void> {
  const pathName = mediamtxPathForCamera(camera.id);
  // streamUrl is stored encrypted and decrypts to null if SECRET_ENCRYPTION_KEY
  // is wrong or missing (a restore onto a new host, a rotated key). Passing that
  // null to MediaMTX creates a path with no source: the camera silently never
  // records, and nothing anywhere says why. Fail loudly with the actual cause.
  if (!camera.streamUrl) {
    throw new Error(
      `Camera "${camera.name}" (${camera.id}) has no usable stream URL — the ` +
        `stored credential could not be decrypted. Check that ` +
        `SECRET_ENCRYPTION_KEY matches the key used when this camera was saved, ` +
        `then re-enter the camera's stream URL.`
    );
  }
  await mtxRequest("POST", `/v3/config/paths/replace/${encodeURIComponent(pathName)}`, {
    source: camera.streamUrl,
    sourceOnDemand: false,
    rtspTransport: "tcp",
  });
}

export async function removeCameraPath(cameraId: string): Promise<void> {
  const pathName = mediamtxPathForCamera(cameraId);
  await mtxRequest("DELETE", `/v3/config/paths/delete/${encodeURIComponent(pathName)}`).catch(() => {});
}

/** Builds the GStreamer H.265->H.264 transcode command run by MediaMTX's runOnDemand. */
function buildTranscodeCommand(sourcePathName: string, gpuVendor: GpuVendor): string {
  const srcRtsp = `rtsp://127.0.0.1:${MTX_RTSP_PORT}/${sourcePathName}`;
  // $MTX_PATH is injected by MediaMTX at spawn time = this on-demand path's own name.
  const dstRtsp = `rtsp://127.0.0.1:${MTX_RTSP_PORT}/$MTX_PATH`;

  let decodeEncode: string;
  if (gpuVendor === "nvidia") {
    decodeEncode = "nvh265dec ! nvh264enc preset=low-latency-hq bitrate=2000";
  } else if (gpuVendor === "vaapi") {
    decodeEncode = "vah265dec ! vah264enc";
  } else {
    decodeEncode = "avdec_h265 ! videoconvert ! x264enc tune=zerolatency speed-preset=veryfast bitrate=2000 key-int-max=50";
  }

  return [
    GST_LAUNCH_PATH, "-e",
    "rtspsrc", `location=${srcRtsp}`, "protocols=tcp", "latency=200", "!",
    "rtph265depay", "!", "h265parse", "!",
    decodeEncode, "!",
    "h264parse", "!",
    "rtspclientsink", `location=${dstRtsp}`, "protocols=tcp",
  ].join(" ");
}

/**
 * Ensures the on-demand H.265->H.264 fallback path exists for a camera.
 * Idempotent: safe to call on every request for the transcoded variant.
 * The GStreamer process behind it only runs while a viewer is connected
 * (MediaMTX's runOnDemand/runOnDemandCloseAfter), so this costs nothing
 * when nobody incompatible is watching.
 */
export async function ensureTranscodePath(cameraId: string): Promise<string> {
  const sourcePathName = mediamtxPathForCamera(cameraId);
  const pathName = transcodePathForCamera(cameraId);
  const gpuVendor = await detectGpuVendor();

  await mtxRequest("POST", `/v3/config/paths/replace/${encodeURIComponent(pathName)}`, {
    runOnDemand: buildTranscodeCommand(sourcePathName, gpuVendor),
    runOnDemandRestart: true,
    runOnDemandStartTimeout: "10s",
    runOnDemandCloseAfter: "15s",
  });

  return pathName;
}

export async function removeTranscodePath(cameraId: string): Promise<void> {
  const pathName = transcodePathForCamera(cameraId);
  await mtxRequest("DELETE", `/v3/config/paths/delete/${encodeURIComponent(pathName)}`).catch(() => {});
}

export interface MtxPathStatus {
  ready: boolean;
  readers: number;
  tracks: string[];
}

export async function getPathStatus(pathName: string): Promise<MtxPathStatus | null> {
  try {
    const data = await mtxRequest("GET", `/v3/paths/get/${encodeURIComponent(pathName)}`);
    return {
      ready: !!data.ready,
      readers: Array.isArray(data.readers) ? data.readers.length : 0,
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
    };
  } catch (err) {
    // Path not configured yet, or MediaMTX is down. Callers treat null as
    // "unknown"; log the reason so it is not mistaken for "camera offline".
    console.warn(`⚠ MediaMTX path status unavailable for ${pathName}:`, err);
    return null;
  }
}

/**
 * Wait until MediaMTX has actually connected to a camera and is serving it.
 *
 * Registering a path is instantaneous, but MediaMTX then has to dial the camera,
 * negotiate RTSP and receive the first frames. Spawning the recorder before that
 * completes makes it hit a 404 and exit, which the supervisor counts as a crash
 * and punishes with exponential backoff — so a perfectly healthy camera takes
 * several extra seconds to start recording, and the delay compounds when many
 * cameras are added at once.
 *
 * Returns true when ready, false on timeout. A false is NOT fatal: the caller
 * still starts the recorder, whose own retry loop handles a genuinely slow or
 * unreachable camera.
 */
export async function waitForPathReady(
  pathName: string,
  timeoutMs = 15_000,
  pollMs = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getPathStatus(pathName);
    if (status?.ready) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export async function listMediaMTXPaths(): Promise<string[]> {
  const data = await mtxRequest("GET", "/v3/paths/list");
  return (data.items || []).map((item: { name: string }) => item.name);
}

export async function healthCheck(): Promise<boolean> {
  try {
    await mtxRequest("GET", "/v3/config/global/get");
    return true;
  } catch (err) {
    console.error(`❌ MediaMTX health check failed at ${MTX_API_BASE}:`, err);
    return false;
  }
}
