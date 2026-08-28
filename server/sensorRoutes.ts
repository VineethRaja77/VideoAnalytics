// server/sensorRoutes.ts
//
//   POST /api/sensors/readings        gateway -> platform   (per-org token)
//   GET  /api/sensors/devices         dashboard             (session, org-scoped)
//   GET  /api/sensors/parking         free/occupied per zone
//   GET  /api/sensors/maintenance     silent + uncalibrated devices
//   GET  /api/sensors/devices/:id/history
//   POST /api/sensors/devices         provision a device    (manager+)
//   POST /api/sensors/devices/:id/calibrate
//
// The ingest path deliberately mirrors /api/analytics/events: the organization
// comes from the TOKEN, never the payload, so a gateway holding one site's
// credential cannot write readings for another tenant even if it knows their
// device ids.

import crypto from "crypto";
import type { Express } from "express";
import { z } from "zod";
import { db, storage } from "./storage";
import { devices, sensorRules, SENSOR_METRICS } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "./auth";
import { requireWriteAccess, resolveOrgScope } from "./rbac";
import { evaluateLicense } from "./entitlements";
import { hashIngestToken } from "./crypto";
import { ingestLimiter } from "./security";
import { audit } from "./audit";
import {
  ingestReading,
  listDeviceStatus,
  zoneOccupancy,
  staleDevices,
  deviceHistory,
} from "./sensors";

const LEGACY_KEY = process.env.ANALYTICS_INGEST_KEY || "";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const readingSchema = z.object({
  deviceId: z.string().min(1),          // the device's externalId
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().optional().nullable(),
  at: z.string().datetime().optional(),
});

// A gateway polling 500 bays sends them in one POST, not 500.
const batchSchema = z.object({
  readings: z.array(readingSchema).min(1).max(1000),
});

const deviceSchema = z.object({
  externalId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  feature: z.string().min(1).max(64),
  site: z.string().max(120).optional().nullable(),
  zone: z.string().max(120).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  heartbeatSeconds: z.number().int().min(10).max(86400).optional(),
  calibrationIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  config: z.record(z.any()).optional().nullable(),
});

export function registerSensorRoutes(app: Express): void {
  /* ------------------------------------------------ INGEST (gateway) ---- */
  app.post("/api/sensors/readings", ingestLimiter, async (req, res) => {
    try {
      const presented = req.header("X-Ingest-Key") || "";
      if (!presented) return res.status(401).json({ error: "Missing ingest key" });

      const org = await storage.getOrganizationByIngestKeyHash(hashIngestToken(presented));
      const legacyOk = !!LEGACY_KEY && timingSafeEqualStr(presented, LEGACY_KEY);
      if (!org && !legacyOk) return res.status(401).json({ error: "Invalid ingest key" });
      if (!org) {
        // The legacy platform-wide key is not tenant-scoped, so it cannot be
        // used here: there would be no safe way to decide whose device this is.
        return res.status(403).json({
          error: "Sensor ingest requires a per-organization token",
          hint: "Mint one with POST /api/admin/organizations/:id/ingest-token",
        });
      }

      const body = batchSchema.parse(
        Array.isArray(req.body?.readings) ? req.body : { readings: [req.body] }
      );

      const results = [];
      let accepted = 0;
      let alerts = 0;
      for (const r of body.readings) {
        const out = await ingestReading(org.id, {
          externalId: r.deviceId,
          metric: r.metric,
          value: r.value,
          unit: r.unit ?? null,
          at: r.at ? new Date(r.at) : undefined,
        });
        if (out.ok) {
          accepted++;
          alerts += out.alerts ?? 0;
        }
        results.push({ deviceId: r.deviceId, ok: out.ok, reason: out.reason, quality: out.quality });
      }

      // 207 when some rows were rejected: a gateway that sends 500 readings and
      // gets a flat 200 will never notice that 3 device ids are mistyped.
      res.status(accepted === body.readings.length ? 201 : 207).json({
        accepted,
        rejected: body.readings.length - accepted,
        alerts,
        results: results.filter((r) => !r.ok).slice(0, 50),
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid reading", details: err.errors });
      }
      console.error("❌ POST /api/sensors/readings failed:", err);
      res.status(500).json({ error: "Sensor ingest failed" });
    }
  });

  /* --------------------------------------------------- READ (dashboard) - */
  app.get("/api/sensors/devices", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      res.json(await listDeviceStatus(orgId));
    } catch (err) {
      console.error("❌ GET /api/sensors/devices failed:", err);
      res.status(500).json({ error: "Failed to read devices" });
    }
  });

  app.get("/api/sensors/parking", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });

      // Licence-gated like every other feature: a client who did not buy
      // bay_occupancy does not get a parking API.
      const [org, licence] = await Promise.all([
        storage.getOrganization(orgId),
        storage.getEffectiveLicense(orgId, "bay_occupancy"),
      ]);
      if (!evaluateLicense(licence, org).ok) {
        return res.status(403).json({ error: "Not licensed for bay_occupancy" });
      }
      res.json(await zoneOccupancy(orgId));
    } catch (err) {
      console.error("❌ GET /api/sensors/parking failed:", err);
      res.status(500).json({ error: "Failed to read parking occupancy" });
    }
  });

  app.get("/api/sensors/maintenance", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      res.json(await staleDevices(orgId));
    } catch (err) {
      console.error("❌ GET /api/sensors/maintenance failed:", err);
      res.status(500).json({ error: "Failed to read maintenance list" });
    }
  });

  app.get("/api/sensors/devices/:id/history", requireAuth, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const hours = Math.min(Number(req.query.hours) || 24, 24 * 30);
      res.json(await deviceHistory(orgId, req.params.id, hours * 3600_000));
    } catch (err) {
      console.error("❌ GET /api/sensors/devices/:id/history failed:", err);
      res.status(500).json({ error: "Failed to read history" });
    }
  });

  /* ------------------------------------------------ PROVISION (manager+) */
  app.post("/api/sensors/devices", requireAuth, requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const body = deviceSchema.parse(req.body);

      const [created] = await db
        .insert(devices)
        .values({ ...body, organizationId: orgId })
        .returning();

      void audit(req, {
        action: "camera_created", // reuses the provisioning action vocabulary
        organizationId: orgId,
        targetType: "device",
        targetId: created.id,
        targetLabel: created.name,
        detail: { kind: created.kind, feature: created.feature, site: created.site },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid device", details: err.errors });
      }
      // A duplicate externalId within one org is a commissioning mistake worth
      // naming precisely rather than returning a bare 500.
      if (String(err).includes("devices_org_external_unique")) {
        return res.status(409).json({ error: "A device with that externalId already exists" });
      }
      console.error("❌ POST /api/sensors/devices failed:", err);
      res.status(500).json({ error: "Failed to create device" });
    }
  });

  app.post("/api/sensors/devices/:id/calibrate", requireAuth, requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });

      const [updated] = await db
        .update(devices)
        .set({ calibratedAt: new Date() })
        .where(and(eq(devices.id, req.params.id), eq(devices.organizationId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Device not found" });

      // Calibration is a compliance-relevant act for water quality: who
      // certified this probe, and when.
      void audit(req, {
        action: "camera_updated",
        organizationId: orgId,
        targetType: "device",
        targetId: updated.id,
        targetLabel: updated.name,
        detail: { calibrated: true },
      });
      res.json(updated);
    } catch (err) {
      console.error("❌ POST /api/sensors/devices/:id/calibrate failed:", err);
      res.status(500).json({ error: "Failed to record calibration" });
    }
  });

  app.get("/api/sensors/metrics", requireAuth, (_req, res) => {
    res.json({ metrics: SENSOR_METRICS });
  });
}
