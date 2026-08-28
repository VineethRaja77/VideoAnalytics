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
  app.get("/api/analytics/events", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const events = await storage.getAnalyticsEventsByOrg(orgId, {
        module: (req.query.module as string) || undefined,
        cameraId: (req.query.cameraId as string) || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(events);
    } catch (err) {
      console.error("❌ GET /api/analytics/events failed:", err);
      res.status(500).json({ error: "Failed to fetch events" });
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
