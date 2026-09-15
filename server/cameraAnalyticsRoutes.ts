// server/cameraAnalyticsRoutes.ts
//
// Bind AI modules to cameras — "run PPE + vehicle on camera 3".
//
//   GET    /api/cameras/:cameraId/analytics   list bindings for a camera
//   POST   /api/cameras/:cameraId/analytics   enable a module (licence-gated)
//   PATCH  /api/analytics/bindings/:id        enable/disable, update config
//   POST   /api/analytics/bindings/:id/restart
//   DELETE /api/analytics/bindings/:id
//   GET    /api/analytics/bindings            org-wide status view
//
// Every handler resolves the org via resolveOrgScope and re-reads the camera
// through getCameraForOrg, so one tenant can never bind a module to another
// tenant's camera even by guessing an id.

import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { requireWriteAccess, resolveOrgScope } from "./rbac";
import { evaluateLicense } from "./entitlements";
import { ANALYTICS_FEATURES, FEATURE_MODULE } from "@shared/schema";
import { validateAnalyticsConfig } from "@shared/analyticsConfig";
import { audit } from "./audit";
import type { CameraAnalytics } from "@shared/schema";
import {
  startAnalyticsWorker,
  stopAnalyticsWorker,
  restartAnalyticsWorker,
  getAnalyticsWorkerStatusFor,
  moduleInstalled,
} from "./analyticsWorker";

const bindSchema = z.object({
  // A FEATURE, not a module: the client licenses "intrusion", not "person".
  feature: z.enum(ANALYTICS_FEATURES),
  enabled: z.boolean().default(true),
  config: z.record(z.any()).nullable().optional(),
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.any()).nullable().optional(),
});

export function registerCameraAnalyticsRoutes(app: Express): void {
  // ---- list bindings for one camera ----
  app.get("/api/cameras/:cameraId/analytics", requireAuth, async (req, res) => {
    const orgId = resolveOrgScope(req);
    if (!orgId) return res.status(400).json({ error: "No organization context" });

    const camera =
      req.user?.role === "super_admin"
        ? await storage.getCamera(req.params.cameraId)
        : await storage.getCameraForOrg(req.params.cameraId, orgId);
    if (!camera) return res.status(404).json({ error: "Camera not found" });

    const rows = await storage.getCameraAnalyticsByCamera(camera.id);
    res.json(rows.map((r) => ({ ...r, runtime: getAnalyticsWorkerStatusFor(r.cameraId, r.module, r.feature) })));
  });

  // ---- enable a module on a camera ----
  app.post("/api/cameras/:cameraId/analytics", requireAuth, requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });

      const body = bindSchema.parse(req.body);

      const camera =
        req.user?.role === "super_admin"
          ? await storage.getCamera(req.params.cameraId)
          : await storage.getCameraForOrg(req.params.cameraId, orgId);
      if (!camera || !camera.organizationId) {
        return res.status(404).json({ error: "Camera not found" });
      }

      // Licence is per FEATURE. Checked here AND again in the supervisor
      // before spawn, so neither a stale UI nor a direct DB edit can start an
      // unlicensed analytic.
      const [org, license] = await Promise.all([
        storage.getOrganization(camera.organizationId),
        storage.getEffectiveLicense(camera.organizationId, body.feature),
      ]);
      const check = evaluateLicense(license, org);
      if (!check.ok && req.user?.role !== "super_admin") {
        return res.status(403).json({
          error: "Feature not licensed",
          feature: body.feature,
          reason: check.reason,
        });
      }

      // Fail loudly if the module providing this feature isn't deployed on this
      // host, rather than creating a binding that can never start.
      const mod = FEATURE_MODULE[body.feature];
      if (!moduleInstalled(mod)) {
        return res.status(409).json({
          error: "Module not installed on this server",
          feature: body.feature,
          module: mod,
        });
      }

      // Zones and lines are parsed by the Python worker. A malformed one used
      // to raise there, kill the worker, and leave the supervisor restarting it
      // forever against a config that can never parse — so it is rejected here,
      // where the operator can still see why.
      const problems = validateAnalyticsConfig(
        body.config as Record<string, unknown>,
        body.feature
      );
      if (problems.length) {
        return res.status(400).json({ error: problems[0], details: problems });
      }

      const row = await storage.upsertCameraAnalytics({
        organizationId: camera.organizationId,
        cameraId: camera.id,
        feature: body.feature,
        enabled: body.enabled,
        config: body.config ?? null,
      });

      if (row.enabled) await startAnalyticsWorker(row.id);
      else await stopAnalyticsWorker(row.id);

      // What a camera watches for is a security decision, so it is recorded.
      void audit(req, {
        action: "analytics_binding_changed",
        organizationId: camera.organizationId,
        targetType: "camera_analytics",
        targetId: row.id,
        targetLabel: `${camera.name} / ${body.feature}`,
        detail: { feature: body.feature, enabled: row.enabled, created: true },
      });

      res.status(201).json({ ...row, runtime: getAnalyticsWorkerStatusFor(row.cameraId, row.module, row.feature) });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid binding", details: err.errors });
      }
      console.error("❌ bind analytics failed:", err);
      res.status(500).json({ error: "Failed to bind module" });
    }
  });

  // ---- org-wide status view ----
  app.get("/api/analytics/bindings", requireAuth, async (req, res) => {
    const orgId = resolveOrgScope(req);
    if (!orgId) return res.status(400).json({ error: "No organization context" });
    const rows = await storage.getCameraAnalyticsByOrg(orgId);
    res.json(rows.map((r) => ({ ...r, runtime: getAnalyticsWorkerStatusFor(r.cameraId, r.module, r.feature) })));
  });

  type OwnedResult =
    | { ok: true; row: CameraAnalytics }
    | { ok: false; status: number; error: string };

  /** Load a binding and confirm the caller's org owns it. */
  async function ownedBinding(req: any): Promise<OwnedResult> {
    const orgId = resolveOrgScope(req);
    if (!orgId) return { ok: false, status: 400, error: "No organization context" };
    const row = await storage.getCameraAnalytics(req.params.id);
    if (!row) return { ok: false, status: 404, error: "Binding not found" };
    if (req.user?.role !== "super_admin" && row.organizationId !== orgId) {
      // 404 rather than 403 — do not confirm the id exists in another tenant.
      return { ok: false, status: 404, error: "Binding not found" };
    }
    return { ok: true, row };
  }

  // ---- enable/disable or reconfigure ----
  app.patch("/api/analytics/bindings/:id", requireAuth, requireWriteAccess, async (req, res) => {
    try {
      const found = await ownedBinding(req);
      if (!found.ok) return res.status(found.status).json({ error: found.error });
      const patch = patchSchema.parse(req.body);
      const row = found.row;

      const problems = validateAnalyticsConfig(
        patch.config as Record<string, unknown>,
        row.feature
      );
      if (problems.length) {
        return res.status(400).json({ error: problems[0], details: problems });
      }

      const next = await storage.upsertCameraAnalytics({
        organizationId: row.organizationId,
        cameraId: row.cameraId,
        feature: row.feature as (typeof ANALYTICS_FEATURES)[number],
        enabled: patch.enabled ?? row.enabled,
        config: patch.config === undefined ? (row.config as any) : patch.config,
      });

      // Config changes only reach the worker through its environment at spawn,
      // so a running worker must be restarted for them to take effect.
      if (!next.enabled) await stopAnalyticsWorker(next.id);
      else await restartAnalyticsWorker(next.id);

      // Moving a zone changes what the site treats as a violation, so it is
      // recorded separately from merely enabling or disabling the feature.
      void audit(req, {
        action: patch.config !== undefined
          ? "analytics_zone_changed"
          : "analytics_binding_changed",
        organizationId: next.organizationId,
        targetType: "camera_analytics",
        targetId: next.id,
        targetLabel: next.feature,
        detail: {
          feature: next.feature,
          enabled: next.enabled,
          // The geometry itself, so "who moved the zone, and to where" is
          // answerable months later. It is site layout, not personal data.
          config: patch.config ?? undefined,
        },
      });

      res.json({ ...next, runtime: getAnalyticsWorkerStatusFor(next.cameraId, next.module, next.feature) });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid patch", details: err.errors });
      }
      console.error("❌ patch analytics binding failed:", err);
      res.status(500).json({ error: "Failed to update binding" });
    }
  });

  // ---- manual restart ----
  app.post("/api/analytics/bindings/:id/restart", requireAuth, requireWriteAccess, async (req, res) => {
    const found = await ownedBinding(req);
    if (!found.ok) return res.status(found.status).json({ error: found.error });
    await restartAnalyticsWorker(found.row.id);
    res.json({ success: true });
  });

  // ---- unbind ----
  app.delete("/api/analytics/bindings/:id", requireAuth, requireWriteAccess, async (req, res) => {
    const found = await ownedBinding(req);
    if (!found.ok) return res.status(found.status).json({ error: found.error });
    await stopAnalyticsWorker(found.row.id);
    await storage.deleteCameraAnalytics(found.row.id);
    void audit(req, {
      action: "analytics_binding_changed",
      organizationId: found.row.organizationId,
      targetType: "camera_analytics",
      targetId: found.row.id,
      targetLabel: found.row.feature,
      detail: { feature: found.row.feature, removed: true },
    });
    res.json({ success: true });
  });
}
