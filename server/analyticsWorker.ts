// server/analyticsWorker.ts
//
// Supervises the Python AI workers. Same production supervision as
// recordingWorker (staggered start, exponential-backoff+jitter restart,
// watchdog) plus two things recording does not need:
//
//   1. LICENCE ENFORCEMENT AT RUNTIME, PER FEATURE. A feature only runs if the
//      owning org holds a valid licence for it, re-checked on a timer so an
//      expired licence STOPS the analytic on the box — gating HTTP routes alone
//      would leave an already-running process untouched.
//
//   2. ONE PROCESS PER (CAMERA, MODULE), NOT PER FEATURE. Six person analytics
//      on one camera share a detector and a tracker; spawning six processes
//      would compute the same boxes six times. The supervisor groups the
//      licensed feature rows and passes ENABLED_FEATURES to a single worker.
//
// Model artifacts are checksum-verified before spawn: wrong weights produce
// plausible-but-wrong detections, which is worse than not running.

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { emitEvent } from "./events";
import { evaluateLicense } from "./entitlements";
import { mediamtxPathForCamera } from "./mediamtxController";
import { verifyModule } from "./modelRegistry";
import type { Camera, CameraAnalytics } from "@shared/schema";

const MODELS_BASE = process.env.MODELS_BASE || path.join(process.cwd(), "models");
const MTX_RTSP_PORT = process.env.MTX_RTSP_PORT || "8554";
const MTX_HOST = process.env.MTX_HOST || "127.0.0.1";
const PLATFORM_API = process.env.PLATFORM_SELF_URL || "http://127.0.0.1:5000";

const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 300_000;
const STARTUP_STAGGER_MS = 1_500;
const WATCHDOG_INTERVAL_MS = 30_000;
const LICENCE_RECHECK_MS = 60_000;
/**
 * A worker that stays up this long is considered healthy, and its crash-backoff
 * counter resets. Without this, a worker that crashed ten times during a network
 * outage months ago sits at the 300s maximum delay forever — so the NEXT, wholly
 * unrelated blip costs five minutes of lost analytics instead of three seconds.
 * recordingWorker resets on each saved segment; a worker has no segments, so
 * sustained uptime is the equivalent proof of health.
 */
const HEALTHY_UPTIME_MS = 120_000;
/**
 * Consecutive crashes before the client admin is told. Below this it is a blip
 * and self-healing; at or above it, something is actually broken (bad model
 * file, unreachable camera, OOM) and a human must look.
 */
const FAILING_ALERT_THRESHOLD = 5;

/** Key identifying one worker process. */
type GroupKey = string; // `${cameraId}:${module}`
const groupKey = (cameraId: string, module: string): GroupKey => `${cameraId}:${module}`;

interface WorkerState {
  proc: ChildProcess | null;
  cameraId: string;
  module: string;
  featureIds: string[];      // binding row ids this process serves
  features: string[];        // feature names passed to the worker
  restartCount: number;
  /** When the current process was spawned — used to judge sustained health. */
  startedAt: number;
  /** True once the admin has been alerted, so we alert once, not every crash. */
  failingAlertSent: boolean;
  backoffTimer: NodeJS.Timeout | null;
  staggerTimer: NodeJS.Timeout | null;
  stopping: boolean;
  lastLicenceCheck: number;
}

const workers = new Map<GroupKey, WorkerState>();
let watchdogTimer: NodeJS.Timeout | null = null;

function moduleDir(module: string): string {
  return path.join(MODELS_BASE, module);
}

function venvPythonFor(module: string): string {
  return path.join(moduleDir(module), ".venv", "bin", "python");
}

function pythonFor(module: string): string {
  const venv = venvPythonFor(module);
  return fs.existsSync(venv) ? venv : "python3";
}

export function moduleInstalled(module: string): boolean {
  return fs.existsSync(path.join(moduleDir(module), "worker.py"));
}

/**
 * Does this module have its own Python environment?
 *
 * Checked BEFORE spawning, because the fallback to system `python3` is silently
 * fatal: the worker dies on `import dotenv` before it can print anything
 * useful, the supervisor records a crash, and it restart-loops forever while
 * the analytic quietly produces nothing. Four of six modules were in exactly
 * this state on the development box.
 *
 * A module with no requirements.txt needs no venv, so it is not required to
 * have one.
 */
export function moduleEnvReady(module: string): boolean {
  const needsEnv = fs.existsSync(path.join(moduleDir(module), "requirements.txt"));
  return !needsEnv || fs.existsSync(venvPythonFor(module));
}

async function setRuntime(
  ids: string[],
  patch: Parameters<typeof storage.updateCameraAnalyticsRuntime>[1]
): Promise<void> {
  // Runtime state is per-process but stored per-binding, so every feature row
  // in the group reflects the same process status.
  await Promise.all(
    ids.map((id) =>
      storage
        .updateCameraAnalyticsRuntime(id, patch)
        .catch((err) => console.error(`❌ analytics runtime update ${id}:`, err))
    )
  );
}

/** Feature-level licence check, using the same rules as the HTTP layer. */
async function licensedFeatures(rows: CameraAnalytics[]): Promise<CameraAnalytics[]> {
  if (!rows.length) return [];
  const org = await storage.getOrganization(rows[0].organizationId);
  const out: CameraAnalytics[] = [];
  for (const r of rows) {
    const license = await storage.getEffectiveLicense(r.organizationId, r.feature);
    if (evaluateLicense(license, org).ok) out.push(r);
  }
  return out;
}

function workerEnv(
  camera: Camera,
  module: string,
  rows: CameraAnalytics[],
  ingestToken: string
): NodeJS.ProcessEnv {
  const rtsp = `rtsp://${MTX_HOST}:${MTX_RTSP_PORT}/${mediamtxPathForCamera(camera.id)}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOURCE_RTSP: rtsp,
    CAMERA_ID: camera.id,
    POST_EVENTS: "true",
    PLATFORM_API,
    // The worker enables ONLY these rules. A feature the org is not licensed
    // for never reaches this list, so it cannot run even by accident.
    ENABLED_FEATURES: rows.map((r) => r.feature).join(","),
    PPE_INGEST_KEY: ingestToken,
    VEHICLE_INGEST_KEY: ingestToken,
    FACE_INGEST_KEY: ingestToken,
    ANALYTICS_INGEST_KEY: ingestToken,
  };

  // Per-feature config merged into the environment. Later features win on a key
  // collision, which is why config keys should be feature-specific
  // (COUNT_LINE, INTRUSION_ZONE, ...) rather than generic.
  for (const r of rows) {
    for (const [k, v] of Object.entries((r.config ?? {}) as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      env[k.toUpperCase()] = String(v);
    }
  }
  return env;
}

/**
 * The token workers authenticate to /api/analytics/events with.
 *
 * Only the HASH of an org's token is stored, so it cannot be read back out of
 * the database. The deployment supplies the plaintext: on an on-prem box (one
 * org per install) set ANALYTICS_INGEST_KEY to that org's minted token and
 * ingest becomes tenant-scoped automatically.
 */
function ingestTokenForWorkers(): string {
  return process.env.ANALYTICS_INGEST_KEY || "";
}

function spawnWorker(camera: Camera, state: WorkerState, rows: CameraAnalytics[]): void {
  const dir = moduleDir(state.module);
  const py = pythonFor(state.module);
  const tag = `[${state.module}:${camera.name}]`;

  console.log(`▶ analytics: ${state.module} for "${camera.name}" ` +
              `features=[${state.features.join(",")}]`);
  const proc = spawn(py, ["-u", "worker.py"], {
    cwd: dir,
    env: workerEnv(camera, state.module, rows, ingestTokenForWorkers()),
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.proc = proc;
  state.startedAt = Date.now();
  void setRuntime(state.featureIds, {
    status: "running",
    pid: proc.pid ?? null,
    lastStartedAt: new Date(),
    lastHeartbeatAt: new Date(),
    lastError: null,
  });

  proc.stdout?.on("data", (c) => {
    const line = c.toString().trim();
    if (line) console.log(`${tag} ${line}`);
    void setRuntime(state.featureIds, { lastHeartbeatAt: new Date() });
  });
  proc.stderr?.on("data", (c) => {
    const line = c.toString().trim();
    if (line) console.error(`${tag} ${line}`);
  });

  proc.on("error", (err) => {
    console.error(`❌ analytics ${tag} spawn error:`, err);
    void setRuntime(state.featureIds, {
      status: "crashed",
      lastError: String(err).slice(0, 500),
    });
  });

  proc.on("exit", (code, signal) => {
    state.proc = null;
    const key = groupKey(state.cameraId, state.module);
    if (state.stopping) {
      void setRuntime(state.featureIds, { status: "stopped", pid: null });
      return;
    }

    // A process that ran a long time before dying was healthy; its crash is a
    // fresh incident, not a continuation of an old restart storm. Reset first so
    // the delay below is computed from this incident only.
    const uptimeMs = state.startedAt ? Date.now() - state.startedAt : 0;
    if (uptimeMs >= HEALTHY_UPTIME_MS && state.restartCount > 0) {
      console.log(
        `↺ analytics ${tag} had been up ${Math.round(uptimeMs / 1000)}s — ` +
          `clearing restart backoff (was ${state.restartCount})`
      );
      state.restartCount = 0;
      state.failingAlertSent = false;
    }

    console.warn(
      `⚠ analytics ${tag} exited code=${code} signal=${signal} ` +
        `after ${Math.round(uptimeMs / 1000)}s uptime — restarting`
    );
    emitEvent(
      "analytics_worker_crashed",
      `${state.module} worker for "${camera.name}" stopped unexpectedly (code=${code}) — restarting`,
      camera
    );

    state.restartCount += 1;

    // Escalate: repeated crashes are not self-healing and the client admin needs
    // to know, with the actual exit code in the message rather than "a worker
    // had a problem". Sent once per failure streak.
    if (state.restartCount >= FAILING_ALERT_THRESHOLD && !state.failingAlertSent) {
      state.failingAlertSent = true;
      emitEvent(
        "analytics_worker_failing",
        `${state.module} analytics for "${camera.name}" has crashed ` +
          `${state.restartCount} times in a row (last exit code=${code} signal=${signal}). ` +
          `It is no longer producing events for ${state.features.join(", ")}. ` +
          `Check the camera stream and the server log for "${tag}".`,
        camera
      );
    }
    void setRuntime(state.featureIds, {
      status: "crashed",
      pid: null,
      restartCount: state.restartCount,
      lastError: `exit code=${code} signal=${signal}`,
    });

    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** state.restartCount);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    console.log(`↻ analytics ${tag} restart in ${Math.round(jittered / 1000)}s`);

    state.backoffTimer = setTimeout(() => {
      // Re-resolve the whole group: features may have been disabled, unbound or
      // unlicensed while we were backing off.
      void startWorkerGroup(state.cameraId, state.module).catch(() =>
        workers.delete(key)
      );
    }, jittered);
  });
}

/** Start (or refresh) the single worker serving one (camera, module). */
export async function startWorkerGroup(
  cameraId: string,
  module: string,
  staggerIndex = 0
): Promise<void> {
  const key = groupKey(cameraId, module);
  const existing = workers.get(key);
  if (existing?.proc) return; // already running

  const all = await storage.getCameraAnalyticsByCameraModule(cameraId, module);
  const enabled = all.filter((r) => r.enabled);
  if (!enabled.length) {
    workers.delete(key);
    return;
  }

  if (!moduleInstalled(module)) {
    console.warn(`⚠ analytics: module "${module}" not installed at ${moduleDir(module)}`);
    await setRuntime(enabled.map((r) => r.id), {
      status: "crashed",
      lastError: "module not installed on this host",
    });
    return;
  }

  // Fail here with an actionable message rather than spawning a process that
  // cannot possibly import its dependencies.
  if (!moduleEnvReady(module)) {
    const msg =
      `Python environment missing for "${module}" — expected ` +
      `${venvPythonFor(module)}. The worker cannot start. ` +
      `Build it with:  ./scripts/install-models.sh ${module}`;
    console.error(`⛔ analytics: ${msg}`);
    // Loaded here so the notification is scoped to the OWNING tenant. Emitting
    // without a camera would make it a platform-wide notice visible to every
    // client, disclosing another tenant's broken analytics.
    const cam = await storage.getCamera(cameraId);
    emitEvent(
      "analytics_worker_failing",
      `${module} analytics cannot start on this server: its Python environment ` +
        `is not installed. Run scripts/install-models.sh ${module} on the host. ` +
        `No ${module} events will be produced until this is fixed.`,
      cam ?? undefined
    );
    await setRuntime(enabled.map((r) => r.id), {
      status: "crashed",
      lastError: msg.slice(0, 500),
    });
    return;
  }

  const artifacts = verifyModule(module);
  if (!artifacts.ok) {
    console.error(`⛔ analytics: ${module} artifacts invalid — ${artifacts.reason}`);
    await setRuntime(enabled.map((r) => r.id), {
      status: "crashed",
      lastError: `model artifacts invalid: ${artifacts.reason}`,
    });
    return;
  }

  const licensed = await licensedFeatures(enabled);
  const unlicensed = enabled.filter((r) => !licensed.some((l) => l.id === r.id));
  if (unlicensed.length) {
    await setRuntime(unlicensed.map((r) => r.id), {
      status: "unlicensed",
      pid: null,
      lastError: "no valid licence for this feature",
    });
  }
  if (!licensed.length) {
    workers.delete(key);
    return;
  }

  const camera = await storage.getCamera(cameraId);
  if (!camera) return;

  const state: WorkerState = existing ?? {
    proc: null,
    cameraId,
    module,
    featureIds: [],
    features: [],
    restartCount: 0,
    startedAt: 0,
    failingAlertSent: false,
    backoffTimer: null,
    staggerTimer: null,
    stopping: false,
    lastLicenceCheck: Date.now(),
  };
  state.stopping = false;
  state.featureIds = licensed.map((r) => r.id);
  state.features = licensed.map((r) => r.feature);
  workers.set(key, state);

  await setRuntime(state.featureIds, { status: "starting" });
  state.staggerTimer = setTimeout(
    () => spawnWorker(camera, state, licensed),
    staggerIndex * STARTUP_STAGGER_MS
  );
}

/** Stop the worker serving one (camera, module). */
export async function stopWorkerGroup(cameraId: string, module: string): Promise<void> {
  const key = groupKey(cameraId, module);
  const state = workers.get(key);
  if (!state) return;

  state.stopping = true;
  if (state.backoffTimer) clearTimeout(state.backoffTimer);
  if (state.staggerTimer) clearTimeout(state.staggerTimer);
  const proc = state.proc;
  try {
    // SIGTERM first so the worker releases its RTSP handle; SIGKILL only if it
    // is still alive after a grace period.
    proc?.kill("SIGTERM");
    setTimeout(() => {
      try {
        if (proc && !proc.killed) proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5_000);
  } catch {
    /* already dead */
  }
  workers.delete(key);
  await setRuntime(state.featureIds, { status: "stopped", pid: null });
}

/* ---------- binding-id API used by the HTTP routes ---------- */

async function groupOf(bindingId: string): Promise<{ cameraId: string; module: string } | null> {
  const row = await storage.getCameraAnalytics(bindingId);
  return row ? { cameraId: row.cameraId, module: row.module } : null;
}

/** Enabling one feature restarts its group so the worker picks it up. */
export async function startAnalyticsWorker(bindingId: string, staggerIndex = 0): Promise<void> {
  const g = await groupOf(bindingId);
  if (!g) return;
  // The process must be recreated: ENABLED_FEATURES is passed at spawn time.
  await stopWorkerGroup(g.cameraId, g.module);
  await startWorkerGroup(g.cameraId, g.module, staggerIndex);
}

export async function stopAnalyticsWorker(bindingId: string): Promise<void> {
  const g = await groupOf(bindingId);
  if (!g) {
    await setRuntime([bindingId], { status: "stopped", pid: null });
    return;
  }
  await setRuntime([bindingId], { status: "stopped", pid: null });
  // Other features of the same module may still be licensed and enabled, so
  // restart the group rather than killing it outright.
  await stopWorkerGroup(g.cameraId, g.module);
  await startWorkerGroup(g.cameraId, g.module);
}

export async function restartAnalyticsWorker(bindingId: string): Promise<void> {
  const g = await groupOf(bindingId);
  if (!g) return;
  await stopWorkerGroup(g.cameraId, g.module);
  setTimeout(() => void startWorkerGroup(g.cameraId, g.module), 1_000);
}

export interface AnalyticsWorkerStatus {
  running: boolean;
  pid: number | null;
  restartCount: number;
  sharedWith: string[]; // other features served by the same process
}

export function getAnalyticsWorkerStatusFor(
  cameraId: string,
  module: string,
  feature?: string
): AnalyticsWorkerStatus {
  const s = workers.get(groupKey(cameraId, module));
  return {
    running: !!s?.proc,
    pid: s?.proc?.pid ?? null,
    restartCount: s?.restartCount ?? 0,
    sharedWith: (s?.features ?? []).filter((f) => f !== feature),
  };
}

/**
 * Watchdog. Re-evaluates every group:
 *   licence revoked -> stop; licence restored -> start;
 *   enabled-but-not-running -> start; all-disabled -> stop.
 * This is what makes suspending a client's feature take effect on the box
 * rather than only in the UI.
 */
function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    try {
      const rows = await storage.getAllCameraAnalytics();
      const groups = new Map<GroupKey, { cameraId: string; module: string }>();
      for (const r of rows) {
        groups.set(groupKey(r.cameraId, r.module), { cameraId: r.cameraId, module: r.module });
      }

      for (const [key, g] of groups) {
        const state = workers.get(key);
        const running = !!state?.proc;
        const mine = rows.filter((r) => r.cameraId === g.cameraId && r.module === g.module);
        const enabled = mine.filter((r) => r.enabled);

        if (!enabled.length) {
          if (running) await stopWorkerGroup(g.cameraId, g.module);
          continue;
        }

        const now = Date.now();
        if (!state || now - state.lastLicenceCheck > LICENCE_RECHECK_MS) {
          if (state) state.lastLicenceCheck = now;
          const licensed = await licensedFeatures(enabled);

          // The licensed set changed while running -> respawn so the worker's
          // ENABLED_FEATURES matches entitlement again.
          const changed =
            running &&
            (licensed.length !== state!.featureIds.length ||
              licensed.some((l) => !state!.featureIds.includes(l.id)));

          if (!licensed.length) {
            if (running) {
              console.warn(`⛔ analytics: all features unlicensed for ${g.module} — stopping`);
              await stopWorkerGroup(g.cameraId, g.module);
            }
            await setRuntime(enabled.map((r) => r.id), {
              status: "unlicensed",
              pid: null,
              lastError: "no valid licence for this feature",
            });
            continue;
          }
          if (changed) {
            console.log(`↻ analytics: licensed feature set changed for ${g.module} — respawning`);
            await stopWorkerGroup(g.cameraId, g.module);
            await startWorkerGroup(g.cameraId, g.module);
            continue;
          }
        }

        if (!running && !state?.backoffTimer && !state?.staggerTimer) {
          await startWorkerGroup(g.cameraId, g.module);
        }
      }
    } catch (err) {
      console.error("❌ analytics watchdog failed:", err);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/** Boot: start one worker per (camera, module) with enabled+licensed features. */
export async function initAnalyticsWorkersFromDB(): Promise<void> {
  const rows = await storage.getAllCameraAnalytics();

  // pids from a previous process are stale
  await setRuntime(rows.map((r) => r.id), { status: "stopped", pid: null });

  const groups = new Map<GroupKey, { cameraId: string; module: string }>();
  for (const r of rows.filter((x) => x.enabled)) {
    groups.set(groupKey(r.cameraId, r.module), { cameraId: r.cameraId, module: r.module });
  }
  console.log(
    `🧠 analytics: ${rows.filter((r) => r.enabled).length} enabled feature(s) ` +
      `across ${groups.size} worker process(es)`
  );

  let i = 0;
  for (const g of groups.values()) {
    await startWorkerGroup(g.cameraId, g.module, i++);
  }
  startWatchdog();
}

export async function shutdownAnalyticsWorkers(): Promise<void> {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  await Promise.all(
    [...workers.values()].map((s) => stopWorkerGroup(s.cameraId, s.module))
  );
}
