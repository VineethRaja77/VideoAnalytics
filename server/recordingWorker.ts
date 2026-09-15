// server/recordingWorker.ts
//
// Supervises one GStreamer process per camera that consumes MediaMTX's
// re-published RTSP stream (never the camera directly) and stream-copies it
// into segmented local MP4s. Replaces the old ffmpeg spawn/kill logic in the
// deleted streamManager.ts with production-grade supervision: staggered
// startup, exponential-backoff+jitter restart, and a stall watchdog — none
// of which existed before.

import { spawn, execFile, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import * as chokidar from "chokidar";
import { storage } from "./storage";
import type { Camera } from "@shared/schema";
import { emitEvent } from "./events";
import { mediamtxPathForCamera } from "./mediamtxController";

const RECORDINGS_BASE =
  process.env.RECORDINGS_BASE || path.join(process.cwd(), "dev_recordings", "recordings");

const MTX_RTSP_PORT = process.env.MTX_RTSP_PORT || "8554";
const GST_LAUNCH_PATH = process.env.GST_LAUNCH_PATH || "gst-launch-1.0";

const STALL_WINDOW_MS = 90_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 120_000;
const STARTUP_STAGGER_MS = 250;
/**
 * Length of one recording segment.
 *
 * 10 minutes by default (matching the old ffmpeg behaviour). Configurable
 * because it is a real operational trade-off, not a constant: shorter segments
 * give finer retention granularity and lose less footage when a recorder dies
 * mid-segment, at the cost of more files and more database rows. The end-to-end
 * test also needs it short enough to observe a completed segment.
 */
const SEGMENT_TIME_SECONDS = Math.max(
  5,
  Number(process.env.RECORDING_SEGMENT_SECONDS || 600)
);

interface RecorderState {
  proc: ChildProcess | null;
  cameraId: string;
  restartCount: number;
  lastSegmentAt: number;
  watchdogTimer: NodeJS.Timeout | null;
  backoffTimer: NodeJS.Timeout | null;
  staggerTimer: NodeJS.Timeout | null;
  stopping: boolean;
  watcher: chokidar.FSWatcher | null;
}

const recorders = new Map<string, RecorderState>();

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function recFolderFor(camera: Camera): string {
  const folderName = `${sanitizeFolderName(camera.name)}-${camera.id.substring(0, 8)}`;
  return path.join(RECORDINGS_BASE, folderName);
}

const RECORDING_FILENAME_RE = /^recording-(\d+)\.mp4$/;

/** Next splitmuxsink fragment index, continuing from whatever's already on disk. */
function nextStartIndex(recFolder: string): number {
  if (!fs.existsSync(recFolder)) return 0;
  const indices = fs
    .readdirSync(recFolder)
    .map((f) => f.match(RECORDING_FILENAME_RE))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => parseInt(m[1], 10));
  return indices.length > 0 ? Math.max(...indices) + 1 : 0;
}

function gstArgsFor(camera: Camera, recFolder: string): string[] {
  const srcRtsp = `rtsp://127.0.0.1:${MTX_RTSP_PORT}/${mediamtxPathForCamera(camera.id)}`;
  const depay = camera.videoCodec === "h265" ? "rtph265depay" : "rtph264depay";
  const parse = camera.videoCodec === "h265" ? "h265parse" : "h264parse";
  // splitmuxsink's `location` only supports a numeric fragment index (%d), not
  // strftime tokens — recording start/end times are derived from filesystem
  // timestamps in setupRecordingWatcher below instead of the filename.
  const pattern = path.join(recFolder, "recording-%05d.mp4");

  return [
    "-e",
    "rtspsrc", `location=${srcRtsp}`, "protocols=tcp", "latency=200",
    "!", depay,
    "!", parse, "config-interval=1",
    "!", "splitmuxsink", `location=${pattern}`,
    `max-size-time=${SEGMENT_TIME_SECONDS * 1_000_000_000}`,
    `start-index=${nextStartIndex(recFolder)}`,
    // Fragmented MP4 (moov written up front, periodic self-contained moof/mdat
    // fragments) instead of a single trailer written only on clean EOS.
    // Verified empirically: a plain `muxer=mp4mux` segment that gets killed
    // mid-write (a crash, an abrupt restart, the stall watchdog) ends up with
    // no moov at all and is permanently unplayable — every currently-open
    // segment at the moment of any interruption was silently corrupted this
    // way. With fragmentation, only the last <4s since the previous fragment
    // is ever at risk; everything before it stays valid and playable.
    // muxer-properties/muxer-factory are only honored when async-finalize=true
    // (silently ignored otherwise — confirmed via gst-inspect-1.0 splitmuxsink).
    "async-finalize=true",
    "muxer-factory=mp4mux",
    "muxer-properties=properties,fragment-duration=4000",
  ];
}

/* -------------------------------------------------------
   RECORDING WATCHER — detects finished segments, remuxes them for instant
   playback, and indexes them in Postgres
-------------------------------------------------------- */

/**
 * Remuxes a finished fragmented segment into a faststart MP4 (moov with real
 * duration up front). The fragmented format splitmuxsink writes is what makes
 * recording crash-safe, but its header declares no duration, which forces
 * browsers to download the whole file before playing/seeking. Stream-copy
 * remux of a 10-minute segment takes well under a second. On any failure the
 * original (still playable, just slow-loading) file is kept.
 */
function remuxToFaststart(filePath: string, videoCodec: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parse = videoCodec === "h265" ? "h265parse" : "h264parse";
    // Non-.mp4 extensions so the chokidar watcher never sees these as new segments.
    const outTmp = `${filePath}.remuxed`;
    const scratchTmp = `${filePath}.faststart-scratch`;

    const proc = spawn(
      GST_LAUNCH_PATH,
      [
        "filesrc", `location=${filePath}`,
        "!", "qtdemux",
        "!", parse,
        "!", "mp4mux", "faststart=true", `faststart-file=${scratchTmp}`,
        "!", "filesink", `location=${outTmp}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    let stderr = "";
    proc.stderr?.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* raced with a normal exit — the process is already gone */
      }
    }, 60_000);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(outTmp) && fs.statSync(outTmp).size > 0) {
          fs.renameSync(outTmp, filePath);
          resolve(true);
        } else {
          console.error(`❌ Faststart remux failed for ${filePath} (exit ${code}):\n${stderr.slice(-1000)}`);
          fs.rmSync(outTmp, { force: true });
          resolve(false);
        }
      } catch (err) {
        console.error(`❌ Faststart remux rename failed for ${filePath}:`, err);
        resolve(false);
      } finally {
        fs.rmSync(scratchTmp, { force: true });
      }
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/* -------------------------------------------------------
   H.264 COMPATIBILITY VARIANTS
   H.265 recordings stay native on disk (no quality loss, no always-on CPU
   cost), but H.265 doesn't play in every browser/player. On the first
   playback/export request that needs it, the segment is transcoded once to
   an H.264 faststart MP4 cached beside the original (measured: ~7.5s for a
   10-minute 704x480 segment on this hardware), then served from cache.
-------------------------------------------------------- */

const inFlightTranscodes = new Map<string, Promise<string | null>>();

export function h264VariantPath(originalPath: string): string {
  // Doesn't match RECORDING_FILENAME_RE, so the segment watcher ignores it.
  return `${originalPath}.h264.mp4`;
}

export function ensureH264Variant(originalPath: string): Promise<string | null> {
  const variant = h264VariantPath(originalPath);
  if (fs.existsSync(variant) && fs.statSync(variant).size > 0) {
    return Promise.resolve(variant);
  }

  const existing = inFlightTranscodes.get(originalPath);
  if (existing) return existing;

  const job = new Promise<string | null>((resolve) => {
    const outTmp = `${variant}.part`;
    const scratchTmp = `${variant}.faststart-scratch`;
    const proc = spawn(
      GST_LAUNCH_PATH,
      [
        "filesrc", `location=${originalPath}`,
        "!", "qtdemux",
        "!", "h265parse",
        "!", "avdec_h265",
        "!", "videoconvert",
        "!", "x264enc", "speed-preset=veryfast", "bitrate=1500", "key-int-max=60",
        "!", "h264parse",
        "!", "mp4mux", "faststart=true", `faststart-file=${scratchTmp}`,
        "!", "filesink", `location=${outTmp}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    let stderr = "";
    proc.stderr?.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* raced with a normal exit — the process is already gone */
      }
    }, 5 * 60_000);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      inFlightTranscodes.delete(originalPath);
      try {
        if (code === 0 && fs.existsSync(outTmp) && fs.statSync(outTmp).size > 0) {
          fs.renameSync(outTmp, variant);
          resolve(variant);
        } else {
          console.error(`❌ H.264 variant transcode failed for ${originalPath} (exit ${code}):\n${stderr.slice(-1000)}`);
          fs.rmSync(outTmp, { force: true });
          resolve(null);
        }
      } catch (err) {
        console.error(`❌ H.264 variant rename failed:`, err);
        resolve(null);
      } finally {
        fs.rmSync(scratchTmp, { force: true });
      }
    });

    proc.on("error", () => {
      clearTimeout(timer);
      inFlightTranscodes.delete(originalPath);
      resolve(null);
    });
  });

  inFlightTranscodes.set(originalPath, job);
  return job;
}

function setupRecordingWatcher(camera: Camera, recFolder: string): chokidar.FSWatcher {
  const cameraId = camera.id;
  const watcher = chokidar.watch(recFolder, {
    ignored: /^\./,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 5000,
      pollInterval: 500,
    },
  });

  watcher.on("add", async (filePath) => {
    if (!filePath.endsWith(".mp4") || !RECORDING_FILENAME_RE.test(path.basename(filePath))) return;

    const filename = path.basename(filePath);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size < 100 * 1024) {
        console.warn(`⚠️ File too small, skipping: ${filename} (${stats.size} bytes)`);
        return;
      }

      const existing = await storage.getRecordingByFilePath(cameraId, filename);
      if (existing) return;

      // Real start/end from filesystem timestamps: the file was created the
      // moment the segment began (birthtime) and last written when it ended
      // (mtime, stable by now thanks to awaitWriteFinish). Never assume the
      // full SEGMENT_TIME — segments cut short by a restart are shorter, and
      // assuming 600s made the listed start time earlier than the actual
      // footage. Fall back to the old assumption only if the filesystem
      // doesn't track birthtime.
      const endTime = stats.mtime;
      const startTime =
        stats.birthtimeMs > 0
          ? stats.birthtime
          : new Date(endTime.getTime() - SEGMENT_TIME_SECONDS * 1000);
      const duration = Math.max(1, Math.round((endTime.getTime() - startTime.getTime()) / 1000));

      await remuxToFaststart(filePath, camera.videoCodec);
      const finalStats = fs.statSync(filePath);

      await storage.createRecording({
        cameraId,
        organizationId: camera.organizationId,
        startTime,
        endTime,
        filePath: filename,
        duration,
        fileSize: finalStats.size,
      });

      const state = recorders.get(cameraId);
      if (state) {
        state.lastSegmentAt = Date.now();
        // A completed segment proves the recorder is healthy again — reset the
        // crash-backoff counter so a later transient camera flap starts from a
        // short delay instead of an accumulated multi-minute one.
        state.restartCount = 0;
      }

      console.log(
        `✅ Saved to DB: ${filename} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB, ${duration}s)`
      );
    } catch (err) {
      console.error(`❌ Failed to process ${filename}:`, err);
    }
  });

  watcher.on("error", (error) => {
    console.error(`❌ Watcher error for ${cameraId}:`, error);
  });

  return watcher;
}

/* -------------------------------------------------------
   PROCESS SUPERVISION
-------------------------------------------------------- */

function clearTimers(state: RecorderState) {
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  if (state.backoffTimer) clearTimeout(state.backoffTimer);
  if (state.staggerTimer) clearTimeout(state.staggerTimer);
  state.watchdogTimer = null;
  state.backoffTimer = null;
  state.staggerTimer = null;
}

function spawnRecorder(camera: Camera, state: RecorderState) {
  const recFolder = recFolderFor(camera);
  ensureDir(recFolder);

  const args = gstArgsFor(camera, recFolder);
  const proc = spawn(GST_LAUNCH_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });

  const logFile = path.join(recFolder, "gstreamer.log");
  // A failure to append here is usually the FIRST visible symptom of a full or
  // read-only disk. Swallowing it silently is how a disk-full incident becomes
  // an unexplained recording outage, so report it — once per recorder, because
  // stderr arrives continuously and this must not itself flood the log.
  let logWriteFailed = false;
  proc.stderr?.on("data", (chunk) => {
    try {
      fs.appendFileSync(logFile, chunk.toString());
    } catch (err) {
      if (!logWriteFailed) {
        logWriteFailed = true;
        console.error(
          `❌ Cannot write ${logFile} for "${camera.name}" — recording will fail ` +
            `next. Disk full or path not writable:`,
          err
        );
      }
    }
  });

  state.proc = proc;
  state.lastSegmentAt = Date.now();

  storage
    .setRecordingMetadata(camera.id, {
      recordingPid: proc.pid ?? null,
      recordingFolder: recFolder,
      lastStartedAt: new Date(),
    })
    .catch((err) => console.error(`❌ Failed to update recording metadata for ${camera.name}:`, err));

  state.watchdogTimer = setInterval(() => {
    if (state.stopping) return;

    // Liveness is judged by the most recent write activity on disk — the
    // segment currently being written by splitmuxsink keeps growing (and
    // its mtime keeps advancing) throughout the whole segment_time window,
    // so this catches a hung pipeline immediately instead of waiting for a
    // full segment to finish (up to SEGMENT_TIME_SECONDS away).
    try {
      const files = fs
        .readdirSync(recFolder)
        .filter((f) => f.startsWith("recording-") && f.endsWith(".mp4"));
      if (files.length > 0) {
        const mtimes = files.map((f) => fs.statSync(path.join(recFolder, f)).mtimeMs);
        state.lastSegmentAt = Math.max(state.lastSegmentAt, ...mtimes);
      }
    } catch {
      /* folder may not exist yet on the very first tick */
    }

    if (Date.now() - state.lastSegmentAt > STALL_WINDOW_MS) {
      console.warn(`⚠ Recorder for ${camera.name} looks stalled — restarting`);
      emitEvent("recorder_stalled", `Recording for "${camera.name}" stalled and was restarted`, camera);
      try {
        state.proc?.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  proc.on("exit", (code, signal) => {
    console.log(`⚠ Recorder EXIT for ${camera.name} --> code=${code}, signal=${signal}`);
    state.proc = null;
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }

    if (state.stopping) return;

    emitEvent(
      "recorder_crashed",
      `Recording for "${camera.name}" stopped unexpectedly (code=${code}, signal=${signal}) — restarting`,
      camera
    );
    state.restartCount += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** state.restartCount);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    console.log(`↻ Restarting recorder for ${camera.name} in ${Math.round(jittered / 1000)}s`);

    state.backoffTimer = setTimeout(async () => {
      const fresh = await storage.getCamera(camera.id);
      if (!fresh || !fresh.recordingEnabled) return;
      spawnRecorder(fresh, state);
    }, jittered);
  });

  proc.on("error", (err) => {
    console.error(`❌ Recorder process error for ${camera.name}:`, err);
  });
}

export function startRecorder(camera: Camera, staggerIndex = 0): void {
  if (recorders.has(camera.id)) return;

  const state: RecorderState = {
    proc: null,
    cameraId: camera.id,
    restartCount: 0,
    lastSegmentAt: Date.now(),
    watchdogTimer: null,
    backoffTimer: null,
    staggerTimer: null,
    stopping: false,
    watcher: setupRecordingWatcher(camera, recFolderFor(camera)),
  };
  recorders.set(camera.id, state);

  state.staggerTimer = setTimeout(async () => {
    state.staggerTimer = null;
    if (state.stopping) return;

    // Give MediaMTX a chance to actually connect to the camera first. Without
    // this the recorder reliably starts before the stream exists, gets a 404,
    // exits, and is treated as a crash — costing a backoff delay on every
    // single camera start even though nothing was wrong.
    try {
      const { waitForPathReady, mediamtxPathForCamera } = await import("./mediamtxController");
      const ready = await waitForPathReady(mediamtxPathForCamera(camera.id));
      if (!ready) {
        console.warn(
          `⚠ MediaMTX has not connected to "${camera.name}" yet — starting the ` +
            `recorder anyway; it will retry if the camera is unreachable.`
        );
      }
    } catch (err) {
      console.warn(`⚠ Could not check MediaMTX readiness for "${camera.name}":`, err);
    }

    if (state.stopping) return;
    spawnRecorder(camera, state);
  }, staggerIndex * STARTUP_STAGGER_MS);
}

function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    proc.once("exit", done);
    setTimeout(done, timeoutMs);
  });
}

export async function stopRecorder(cameraId: string): Promise<void> {
  const state = recorders.get(cameraId);
  if (!state) {
    await storage.clearRecordingMetadata(cameraId).catch(() => {});
    return;
  }

  state.stopping = true;
  clearTimers(state);

  // Capture a local reference — the process's own "exit" handler (in
  // spawnRecorder) nulls out state.proc concurrently once it fires, so
  // reading state.proc again after awaiting is a race.
  const proc = state.proc;

  if (proc) {
    try {
      proc.kill("SIGTERM"); // gst-launch -e turns this into a clean EOS, finalizing the current segment
      await waitForExit(proc, 5000);
      if (proc.exitCode === null && proc.pid) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch (err) {
      console.warn(`⚠ Error stopping recorder for ${cameraId}:`, err);
    }
  }

  // Give chokidar's awaitWriteFinish (5s stability threshold) time to
  // observe the just-finalized segment settle and index it before we tear
  // the watcher down — closing it immediately would drop that last file.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  if (state.watcher) {
    await state.watcher.close().catch(() => {});
  }

  recorders.delete(cameraId);
  await storage.clearRecordingMetadata(cameraId).catch((err) =>
    console.error(`❌ Failed to clear recording metadata:`, err)
  );
}

export async function restartRecorder(camera: Camera): Promise<void> {
  await stopRecorder(camera.id);
  startRecorder(camera);
}

export interface RecorderStatus {
  running: boolean;
  pid: number | null;
  restartCount: number;
  lastSegmentAt: number | null;
}

/**
 * Whether a recorder is actually RUNNING for each known camera.
 *
 * The `cameras.status` column is an administrative flag set when a camera is
 * created and never touched again — `updateCameraStatus` exists and nothing
 * calls it. Treating it as connectivity made the platform console report every
 * configured camera as "online", so a site whose cameras were all dead still
 * showed green. On a security product that is the worst possible error: the
 * dashboard is most confident exactly when it is most wrong.
 *
 * A camera absent from this map has no recorder in THIS process — which is
 * "unknown", not "offline". Only a camera we are actually supervising can be
 * reported as up or down.
 */
export function recorderRunningByCamera(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [cameraId, state] of recorders) out.set(cameraId, !!state.proc);
  return out;
}

export function getRecorderStatus(cameraId: string): RecorderStatus {
  const state = recorders.get(cameraId);
  if (!state) return { running: false, pid: null, restartCount: 0, lastSegmentAt: null };
  return {
    running: !!state.proc,
    pid: state.proc?.pid ?? null,
    restartCount: state.restartCount,
    lastSegmentAt: state.lastSegmentAt,
  };
}

/* -------------------------------------------------------
   BOOT: reconcile orphans, then start recorders from DB
-------------------------------------------------------- */

/**
 * Kills any gst-launch-1.0 recorder processes left running from a prior
 * Node crash. Recorder commands always contain "splitmuxsink" (the
 * H.265->H.264 transcode commands MediaMTX runs itself don't — they use
 * rtspclientsink instead — so this can't accidentally kill those).
 */
function killOrphanedRecorders(): Promise<void> {
  return new Promise((resolve) => {
    execFile("pkill", ["-f", "gst-launch-1.0.*splitmuxsink"], () => resolve());
  });
}

/**
 * Remove MediaMTX camera paths that no longer correspond to a DB camera
 * (e.g. a camera deleted while the app was down). A stale source-less path
 * otherwise retries its dead source every few seconds forever, spamming logs
 * and wasting connections.
 */
async function reconcileMediaMtxPaths(validCameraIds: Set<string>): Promise<void> {
  try {
    const { listMediaMTXPaths, mediamtxPathForCamera, transcodePathForCamera } = await import("./mediamtxController");
    const valid = new Set<string>();
    for (const id of validCameraIds) {
      valid.add(mediamtxPathForCamera(id));
      valid.add(transcodePathForCamera(id));
    }
    const paths = await listMediaMTXPaths();
    for (const name of paths) {
      if (name.startsWith("cam_") && !valid.has(name)) {
        await fetch(`${process.env.MTX_API_BASE || "http://127.0.0.1:9997"}/v3/config/paths/delete/${encodeURIComponent(name)}`, {
          method: "DELETE",
        }).catch(() => {});
        console.log(`🧹 Removed orphaned MediaMTX path: ${name}`);
      }
    }
  } catch (err) {
    console.error("❌ MediaMTX path reconciliation failed:", err);
  }
}

export async function initRecordersFromDB(): Promise<void> {
  console.log("\n♻ Reconciling recorders from DB on boot...");

  await killOrphanedRecorders();

  const cams = await storage.getRecordingEnabledCameras();
  const allCams = await storage.getAllCameras();
  await reconcileMediaMtxPaths(new Set(allCams.map((c) => c.id)));

  if (!cams || cams.length === 0) {
    console.log("ℹ No cameras configured for recording");
    return;
  }

  const CONCURRENCY = 20;
  for (let i = 0; i < cams.length; i += CONCURRENCY) {
    const batch = cams.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (cam, idx) => {
        const { addOrUpdateCameraPath } = await import("./mediamtxController");
        try {
          await addOrUpdateCameraPath(cam);
        } catch (err) {
          console.error(`❌ Failed to register MediaMTX path for ${cam.name}:`, err);
          return;
        }
        startRecorder(cam, i + idx);
      })
    );
  }

  console.log(`✔ Started reconciliation for ${cams.length} camera(s)`);

  startPathReconciliationLoop();
}

/**
 * Every 2 minutes, ensure every recording-enabled camera still has its path in
 * MediaMTX. Self-heals a lone MediaMTX restart (its dynamic paths are lost on
 * restart) without waiting for an app restart — and only re-registers paths
 * that are actually MISSING, so healthy live streams are never disrupted.
 */
let pathReconcileTimer: NodeJS.Timeout | null = null;
function startPathReconciliationLoop(): void {
  if (pathReconcileTimer) return;
  pathReconcileTimer = setInterval(async () => {
    try {
      const { listMediaMTXPaths, addOrUpdateCameraPath, mediamtxPathForCamera } = await import("./mediamtxController");
      const existing = new Set(await listMediaMTXPaths());
      const cams = await storage.getRecordingEnabledCameras();
      for (const cam of cams) {
        if (!existing.has(mediamtxPathForCamera(cam.id))) {
          console.log(`🔁 Re-registering missing MediaMTX path for ${cam.name}`);
          await addOrUpdateCameraPath(cam).catch((e) =>
            console.error(`❌ Re-register failed for ${cam.name}:`, e)
          );
        }
      }
    } catch (err) {
      console.error("❌ Path reconciliation loop error:", err);
    }
  }, 2 * 60 * 1000);
}
