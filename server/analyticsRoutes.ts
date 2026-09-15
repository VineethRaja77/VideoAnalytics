// server/analyticsRoutes.ts
//
// Analytics events = the output of the AI model workers (PPE, FRS, …).
//   POST /api/analytics/events        ← workers push violations (shared-key auth)
//   GET  /api/analytics/events        ← dashboard reads (session, org-scoped)
//   POST /api/analytics/events/:id/ack← acknowledge an alert (manager+)

import crypto from "crypto";
import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { requireWriteAccess, resolveOrgScope } from "./rbac";
import { evaluateLicense } from "./entitlements";
import { hashIngestToken } from "./crypto";
import { ANALYTICS_FEATURES, MODULE_FEATURES } from "@shared/schema";
import { ingestLimiter } from "./security";
import { audit } from "./audit";

const INGEST_KEY = process.env.ANALYTICS_INGEST_KEY || "";

/** Constant-time compare so the legacy key can't be recovered by timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const ingestSchema = z.object({
  module: z.string().min(1),
  // The licensable feature this event belongs to. Optional so an older worker
  // build keeps working; the handler falls back to the type, then the module's
  // primary feature.
  feature: z.string().min(1).optional(),
  type: z.string().min(1),
  cameraId: z.string().min(1),
  trackId: z.number().nullable().optional(),
  details: z.record(z.any()).nullable().optional(),
  snapshot: z.string().nullable().optional(),
});

export function registerAnalyticsRoutes(app: Express): void {
  // ---- INGEST (worker → platform). Shared-key auth, not a user session. ----
  app.post("/api/analytics/events", ingestLimiter, async (req, res) => {
    try {
      const presented = req.header("X-Ingest-Key") || "";
      if (!presented) return res.status(401).json({ error: "Missing ingest key" });

      // Prefer a per-ORG token: its hash identifies exactly one tenant, so a
      // token leaked from one on-prem site cannot post events for another.
      // The legacy platform-wide key still works for existing deployments but
      // is not scoped — rotate installs onto per-org tokens.
      const org = await storage.getOrganizationByIngestKeyHash(hashIngestToken(presented));
      const legacyOk = !!INGEST_KEY && timingSafeEqualStr(presented, INGEST_KEY);
      if (!org && !legacyOk) {
        return res.status(401).json({ error: "Invalid ingest key" });
      }

      const body = ingestSchema.parse(req.body);

      // Resolve the owning org from the camera, and only store if that org
      // holds a valid license for the module producing the event.
      const camera = await storage.getCamera(body.cameraId);
      if (!camera || !camera.organizationId) return res.status(404).json({ error: "Unknown camera" });

      // Tenant isolation: an org-scoped token may only write events for its own
      // cameras. Without this, a valid token plus a guessed camera id would let
      // one client inject events into another client's dashboard.
      if (org && camera.organizationId !== org.id) {
        return res.status(403).json({ error: "Camera does not belong to this organization" });
      }

      // Licence is per FEATURE, not per module — `person` is a worker, not a
      // product. Resolve in order of specificity:
      //   1. an explicit `feature` from the worker (preferred)
      //   2. the event type, when it IS a feature name (person/object/vehicle
      //      rules all emit the feature as the type)
      //   3. the module's primary feature, so an older worker build that sends
      //      neither still reports instead of silently 403-ing
      const feature =
        body.feature ??
        (ANALYTICS_FEATURES.includes(body.type) ? body.type : undefined) ??
        MODULE_FEATURES[body.module as keyof typeof MODULE_FEATURES]?.[0] ??
        body.module;

      const [ownerOrg, license] = await Promise.all([
        storage.getOrganization(camera.organizationId),
        storage.getEffectiveLicense(camera.organizationId, feature),
      ]);
      if (!evaluateLicense(license, ownerOrg).ok) {
        return res.status(403).json({
          error: "Organization not licensed for this feature",
          feature,
        });
      }

      const event = await storage.createAnalyticsEvent({
        organizationId: camera.organizationId,
        cameraId: body.cameraId,
        module: body.module,
        type: body.type,
        trackId: body.trackId ?? null,
        details: body.details ?? null,
        snapshot: body.snapshot ?? null,
      });
      res.status(201).json({ id: event.id });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid event", details: err.errors });
      console.error("❌ analytics ingest failed:", err);
      res.status(500).json({ error: "Ingest failed" });
    }
  });

  // ---- READ (dashboard). Session-authed, org-scoped. ----
  /**
   * Read the filters off a query string, rejecting nonsense rather than
   * silently ignoring it — a date the server quietly dropped would show the
   * client a list that does not match what they asked for.
   */
  function parseEventQuery(q: any) {
    const asDate = (v: unknown, field: string) => {
      if (v === undefined || v === "") return undefined;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a date`);
      return d;
    };
    const limit = q.limit ? Number(q.limit) : 100;
    const offset = q.offset ? Number(q.offset) : 0;
    if (!Number.isFinite(limit) || limit < 1) throw new Error("limit must be a positive number");
    if (!Number.isFinite(offset) || offset < 0) throw new Error("offset must be zero or more");
    return {
      module: (q.module as string) || undefined,
      cameraId: (q.cameraId as string) || undefined,
      type: (q.type as string) || undefined,
      acknowledged:
        q.acknowledged === undefined || q.acknowledged === ""
          ? undefined
          : String(q.acknowledged) === "true",
      from: asDate(q.from, "from"),
      to: asDate(q.to, "to"),
      limit: Math.min(limit, 1000),
      offset,
    };
  }

  app.get("/api/analytics/events", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const q = parseEventQuery(req.query);
      const [events, total] = await Promise.all([
        storage.getAnalyticsEventsByOrg(orgId, q),
        storage.countAnalyticsEventsByOrg(orgId, q),
      ]);
      // The total is a header rather than a wrapper object so every existing
      // caller that expects a bare array keeps working.
      res.setHeader("X-Total-Count", String(total));
      res.json(events);
    } catch (err: any) {
      if (err?.message?.includes("is not a date") || err?.message?.includes("must be")) {
        return res.status(400).json({ error: err.message });
      }
      console.error("❌ GET /api/analytics/events failed:", err);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  /**
   * The same list as a CSV file.
   *
   * An incident write-up, an insurance claim or a safety review all end with
   * somebody needing the events out of the system. Without this the only route
   * is a screenshot of a table that shows the newest 200 rows.
   */
  app.get("/api/analytics/events.csv", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const q = { ...parseEventQuery(req.query), limit: 5000, offset: 0 };
      const [events, cameras] = await Promise.all([
        storage.getAnalyticsEventsByOrg(orgId, q),
        storage.getCamerasByOrg(orgId),
      ]);
      const cameraName = new Map(cameras.map((c) => [c.id, c.name]));

      // Excel reads a leading "=", "+", "-" or "@" in a cell as a FORMULA, so a
      // detail field carrying one would execute on the reviewer's machine. A
      // leading apostrophe forces it back to text.
      const cell = (v: unknown) => {
        let t = v === null || v === undefined ? "" : String(v);
        if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
        return `"${t.replace(/"/g, '""')}"`;
      };

      // Rendered in the SITE's timezone, not UTC and not the reader's.
      //
      // A spreadsheet has nowhere to put a timezone, so a bare ISO string means
      // whoever opens the file has to know the server runs in UTC and do the
      // arithmetic — and an incident report built on times five and a half
      // hours out is worse than no report. The column says which zone it is in.
      const tz = process.env.APP_TIMEZONE || "Asia/Kolkata";
      const siteTime = (v: unknown) => {
        const d = v instanceof Date ? v : new Date(String(v));
        if (Number.isNaN(d.getTime())) return "";
        const p = new Intl.DateTimeFormat("en-GB", {
          timeZone: tz,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        }).formatToParts(d);
        const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
        return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
      };
      const zoneLabel =
        new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" })
          .formatToParts(new Date())
          .find((x) => x.type === "timeZoneName")?.value ?? tz;

      const header = [
        `time (${zoneLabel})`, "camera", "module", "type", "track", "acknowledged", "detail",
      ];
      const lines = [header.join(",")];
      for (const e of events) {
        lines.push([
          cell(siteTime(e.createdAt)),
          cell(cameraName.get(e.cameraId ?? "") ?? e.cameraId ?? ""),
          cell(e.module),
          cell(e.type),
          cell(e.trackId ?? ""),
          cell(e.acknowledged ? "yes" : "no"),
          cell(JSON.stringify(e.details ?? {})),
        ].join(","));
      }

      void audit(req, {
        action: "analytics_events_exported",
        organizationId: orgId,
        targetType: "analytics_event",
        targetLabel: `${events.length} event(s)`,
        detail: { module: q.module, cameraId: q.cameraId, from: q.from, to: q.to, rows: events.length },
      });

      // The date in the filename is the SITE's date — a report exported at
      // 02:00 IST otherwise carries yesterday's date and looks like the wrong
      // file to whoever receives it.
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="events-${q.module ?? "all"}-${stamp}.csv"`
      );
      // BOM so Excel opens UTF-8 names correctly rather than as mojibake.
      res.send("\uFEFF" + lines.join("\n"));
    } catch (err: any) {
      if (err?.message?.includes("is not a date") || err?.message?.includes("must be")) {
        return res.status(400).json({ error: err.message });
      }
      console.error("❌ GET /api/analytics/events.csv failed:", err);
      res.status(500).json({ error: "Failed to export events" });
    }
  });

  // ---- ACK (manager+). Org-scoped. ----
  app.post("/api/analytics/events/:id/ack", requireAuth, requireWriteAccess, async (req, res) => {
    const orgId = resolveOrgScope(req);
    if (!orgId) return res.status(400).json({ error: "No organization context" });
    await storage.acknowledgeAnalyticsEvent(req.params.id, orgId);
    void audit(req, {
      action: "analytics_event_acknowledged",
      organizationId: orgId,
      targetType: "analytics_event",
      targetId: req.params.id,
    });
    res.json({ success: true });
  });
}
