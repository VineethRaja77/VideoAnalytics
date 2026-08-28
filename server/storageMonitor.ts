// server/storageMonitor.ts
//
// Watches free disk and warns BEFORE the box fills up.
//
// A VMS writes continuously and never stops. Without this, the first symptom of
// a full disk is everything failing at once with unrelated-looking errors:
// GStreamer dies mid-segment, Postgres refuses writes, snapshots vanish, the
// analytics supervisor restart-loops forever because every worker crashes on
// startup. Nothing in that pile says "the disk is full", so an operator spends
// an hour chasing the wrong thing while recording is lost.
//
// Two thresholds, because one is not enough:
//   WARNING   — still recording, but someone needs to act soon
//   CRITICAL  — act now; optionally stop recording rather than corrupt it
//
// Notifications reach every client admin whose cameras live on this box (disk
// is shared infrastructure, so the notice is platform-wide by design).

import { statfs } from "fs";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { emitEvent } from "./events";

const statfsAsync = promisify(statfs);

const CHECK_INTERVAL_MS = Number(process.env.STORAGE_CHECK_INTERVAL_MS || 5 * 60_000);
const WARN_PCT = Number(process.env.STORAGE_WARN_PERCENT || 85);
const CRIT_PCT = Number(process.env.STORAGE_CRITICAL_PERCENT || 93);
/** Absolute floor: a percentage is meaningless on a very large disk. */
const MIN_FREE_GB = Number(process.env.STORAGE_MIN_FREE_GB || 5);

const RECORDINGS_BASE =
  process.env.RECORDINGS_BASE || path.join(process.cwd(), "dev_recordings", "recordings");

let timer: NodeJS.Timeout | null = null;
let lastLevel: "ok" | "warning" | "critical" = "ok";

export interface DiskStatus {
  path: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
  level: "ok" | "warning" | "critical";
  recordingsGB?: number;
}

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Directory size, best-effort and non-fatal. */
function dirSizeBytes(dir: string, budgetMs = 2000): number {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) break; // never let housekeeping stall the server
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree is not worth failing the whole check
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* file vanished mid-walk — normal while recording */
        }
      }
    }
  }
  return total;
}

export async function checkDisk(target = RECORDINGS_BASE): Promise<DiskStatus> {
  // statfs needs an existing path; walk up until we find one.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
  }

  const st = await statfsAsync(probe);
  const total = st.blocks * st.bsize;
  // bavail (available to non-root), not bfree — root-reserved blocks are not
  // usable by this process, and counting them hides the problem.
  const free = st.bavail * st.bsize;
  const usedPercent = total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  const freeGB = gb(free);

  let level: DiskStatus["level"] = "ok";
  if (usedPercent >= CRIT_PCT || freeGB <= MIN_FREE_GB) level = "critical";
  else if (usedPercent >= WARN_PCT) level = "warning";

  return { path: probe, totalGB: gb(total), freeGB, usedPercent, level };
}

/**
 * One check tick. Emits a notification only when the level CHANGES, so an
 * operator gets one alert rather than one every five minutes forever — alert
 * fatigue is why people stop reading notifications.
 */
export async function runCheck(): Promise<DiskStatus> {
  const st = await checkDisk();

  if (st.level !== lastLevel) {
    if (st.level === "critical") {
      st.recordingsGB = gb(dirSizeBytes(RECORDINGS_BASE));
      emitEvent(
        "storage_critical",
        `Disk ${st.usedPercent}% full — only ${st.freeGB} GB free on ${st.path}. ` +
          `Recordings are using ${st.recordingsGB} GB. Recording and analytics will ` +
          `fail when the disk fills. Delete old recordings or add storage now.`
      );
    } else if (st.level === "warning") {
      st.recordingsGB = gb(dirSizeBytes(RECORDINGS_BASE));
      emitEvent(
        "storage_warning",
        `Disk ${st.usedPercent}% full — ${st.freeGB} GB free on ${st.path}. ` +
          `Recordings are using ${st.recordingsGB} GB. Plan to free space or ` +
          `shorten the retention period.`
      );
    } else {
      emitEvent(
        "storage_warning",
        `Disk pressure resolved — ${st.freeGB} GB free (${st.usedPercent}% used).`
      );
    }
    lastLevel = st.level;
  }
  return st;
}

export function startStorageMonitor(): void {
  if (timer) return;
  void runCheck().catch((err) =>
    console.error("❌ storage check failed:", err)
  );
  timer = setInterval(() => {
    void runCheck().catch((err) =>
      console.error("❌ storage check failed:", err)
    );
  }, CHECK_INTERVAL_MS);
  console.log(
    `💾 storage monitor: warn at ${WARN_PCT}%, critical at ${CRIT_PCT}% ` +
      `or under ${MIN_FREE_GB} GB free, every ${Math.round(CHECK_INTERVAL_MS / 1000)}s`
  );
}

export function stopStorageMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed for the admin console and for tests. */
export function resetLevelForTest(): void {
  lastLevel = "ok";
}
