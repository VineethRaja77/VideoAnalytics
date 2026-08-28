// server/snapshotRoutes.ts
//
// Serve analytics snapshots — with authorization and a retention policy.
//
// Previously an event stored a raw filesystem path and nothing served it, so
// either the images were unreachable or (worse) a static mount would have
// exposed every client's images to anyone who could guess a filename. For the
// face module those images are biometric personal data under India's DPDP Act,
// so "unauthenticated static directory" is not an option.
//
//   GET /api/analytics/events/:id/snapshot   authenticated, org-scoped
//
// The path is never taken from the URL: the caller supplies an EVENT id, we
// load that event, check the caller's org owns it, and only then read the file
// recorded on that row. There is no user-controlled path component, so no
// traversal surface.

import fs from "fs";
import path from "path";
import type { Express } from "express";
import { storage, db } from "./storage";
import { requireAuth } from "./auth";
import { resolveOrgScope } from "./rbac";
import { audit } from "./audit";
import { analyticsEvents } from "@shared/schema";
import { and, eq, lt, isNotNull } from "drizzle-orm";

// Snapshots may only be read from inside these roots. Even though the path
// comes from our own DB, confining reads to known directories means a bad row
// (or a future bug that lets one be written) cannot read arbitrary files.
const SNAPSHOT_ROOTS = [
  path.resolve(process.env.MODELS_BASE || path.join(process.cwd(), "models")),
  path.resolve(process.env.SNAPSHOT_BASE || path.join(process.cwd(), "snapshots")),
];

function withinAllowedRoot(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return SNAPSHOT_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

export function registerSnapshotRoutes(app: Express): void {
  app.get("/api/analytics/events/:id/snapshot", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });

      const rows = await db
        .select()
        .from(analyticsEvents)
        .where(eq(analyticsEvents.id, req.params.id));
      const event = rows[0];
      if (!event) return res.status(404).json({ error: "Event not found" });

      // 404 rather than 403 for a foreign event — do not confirm it exists.
      if (req.user?.role !== "super_admin" && event.organizationId !== orgId) {
        return res.status(404).json({ error: "Event not found" });
      }
      if (!event.snapshot) return res.status(404).json({ error: "No snapshot for this event" });

      if (!withinAllowedRoot(event.snapshot)) {
        console.error(`❌ snapshot path outside allowed roots: ${event.snapshot}`);
        return res.status(403).json({ error: "Snapshot path not permitted" });
      }
      if (!fs.existsSync(event.snapshot)) {
        // Expected once retention has purged the file; the event row remains.
        return res.status(410).json({ error: "Snapshot no longer retained" });
      }

      // A face-module snapshot is biometric personal data under the DPDP Act
      // 2023, so every access is recorded. Logged for ALL modules because the
      // module of an event can change meaning over time and under-recording is
      // the failure that matters here.
      void audit(req, {
        action: "snapshot_viewed",
        organizationId: event.organizationId,
        targetType: "analytics_event",
        targetId: event.id,
        targetLabel: `${event.module}/${event.type}`,
        detail: { module: event.module, eventType: event.type, cameraId: event.cameraId },
      });

      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("Content-Type", "image/jpeg");
      fs.createReadStream(event.snapshot).pipe(res);
    } catch (err) {
      console.error("❌ snapshot fetch failed:", err);
      res.status(500).json({ error: "Failed to read snapshot" });
    }
  });
}

/**
 * Delete snapshot FILES older than the retention window and clear their paths.
 *
 * DPDP requires that personal data is not kept longer than necessary, with an
 * automated purge rather than a manual one. Event rows are kept (they are the
 * audit trail); only the images — the identifiable part — are removed.
 */
export async function purgeExpiredSnapshots(): Promise<void> {
  const days = Number(process.env.SNAPSHOT_RETENTION_DAYS || 30);
  if (!Number.isFinite(days) || days <= 0) return; // 0/invalid = retain forever

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = await db
    .select()
    .from(analyticsEvents)
    .where(and(lt(analyticsEvents.createdAt, cutoff), isNotNull(analyticsEvents.snapshot)));

  let removed = 0;
  for (const ev of stale) {
    if (ev.snapshot && withinAllowedRoot(ev.snapshot)) {
      try {
        if (fs.existsSync(ev.snapshot)) {
          fs.unlinkSync(ev.snapshot);
          removed++;
        }
      } catch (err) {
        console.error(`❌ failed to unlink snapshot ${ev.snapshot}:`, err);
        continue; // leave the path so a later run retries
      }
    }
    await db
      .update(analyticsEvents)
      .set({ snapshot: null })
      .where(eq(analyticsEvents.id, ev.id));
  }
  if (removed) console.log(`🧹 Purged ${removed} snapshot(s) older than ${days} days`);

  await purgeOrphanedSnapshots(days);
}

/**
 * Delete snapshot FILES that no event row references.
 *
 * The row-driven purge above only ever reaches files an analytics_events row
 * points at. A worker writes the image to disk BEFORE it POSTs the event, so
 * every failed POST — platform restarting, licence lapsed, network blip, a 500 —
 * leaves an image on disk that no row will ever mention. Nothing else looks at
 * those files, so they accumulate for the life of the install and are a genuine
 * route to a full disk on a busy site.
 *
 * Deliberately conservative:
 *   - only inside SNAPSHOT_ROOTS
 *   - only files older than the retention window (never touches a snapshot
 *     written seconds ago whose POST is still in flight)
 *   - only image extensions
 */
async function purgeOrphanedSnapshots(days: number): Promise<void> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  // Every path still referenced by a row, so a live snapshot is never deleted.
  const referenced = new Set(
    (
      await db
        .select({ snapshot: analyticsEvents.snapshot })
        .from(analyticsEvents)
        .where(isNotNull(analyticsEvents.snapshot))
    )
      .map((r) => r.snapshot)
      .filter((p): p is string => !!p)
      .map((p) => path.resolve(p))
  );

  const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  let orphans = 0;
  let bytes = 0;

  for (const root of SNAPSHOT_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        console.warn(`⚠ snapshot purge could not read ${dir}:`, err);
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // MODELS_BASE is a root, and it also holds venvs, weights and source.
          // Only descend into snapshot output folders.
          if (e.name === ".venv" || e.name === "__pycache__" || e.name === "weights") continue;
          stack.push(full);
          continue;
        }
        if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (referenced.has(path.resolve(full))) continue;
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoffMs) continue; // too new — POST may be in flight
          fs.unlinkSync(full);
          orphans++;
          bytes += st.size;
        } catch (err) {
          console.warn(`⚠ could not remove orphaned snapshot ${full}:`, err);
        }
      }
    }
  }

  if (orphans) {
    console.log(
      `🧹 Purged ${orphans} orphaned snapshot file(s) ` +
        `(${(bytes / 1024 / 1024).toFixed(1)} MB) with no matching event row`
    );
  }
}

/** Run the purge hourly. */
export function startSnapshotRetention(): void {
  void purgeExpiredSnapshots();
  setInterval(() => void purgeExpiredSnapshots(), 60 * 60 * 1000);
}
