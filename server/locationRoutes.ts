// server/locationRoutes.ts
//
//   GET    /api/locations                 the tenant's whole tree, with counts
//   GET    /api/locations/unassigned      cameras/devices not yet placed
//   GET    /api/locations/:id/breadcrumb  "Campus / Tower B / Level 2"
//   GET    /api/locations/:id/cameras     everything at or under this node
//   POST   /api/locations                 create            (manager+)
//   PATCH  /api/locations/:id             rename / re-parent (manager+)
//   DELETE /api/locations/:id             leaf only          (manager+)
//   POST   /api/locations/assign          place a camera or device (manager+)
//
// Every handler resolves the org from the SESSION and passes it into the
// locations module, which scopes each read and write. A location id from
// another tenant simply fails to resolve.

import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import { requireWriteAccess, resolveOrgScope } from "./rbac";
import { audit } from "./audit";
import {
  createLocation, moveLocation, deleteLocation, locationTree,
  camerasInSubtree, breadcrumb, unassigned, assign,
  LocationError,
} from "./locations";
import { db } from "./storage";
import { locations } from "@shared/schema";
import { and, eq } from "drizzle-orm";

const createSchema = z.object({
  name: z.string().min(1).max(160),
  kind: z.string().max(32).optional(),
  parentId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  kind: z.string().max(32).optional(),
  // `null` means "make this a root", which is different from "not supplied".
  parentId: z.string().nullable().optional(),
});

const assignSchema = z.object({
  type: z.enum(["camera", "device"]),
  id: z.string().min(1),
  locationId: z.string().nullable(),
});

/** Turns a LocationError into its intended status instead of a blanket 500. */
function fail(res: any, err: unknown, context: string): void {
  if (err instanceof LocationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`❌ ${context} failed:`, err);
  res.status(500).json({ error: `${context} failed` });
}

export function registerLocationRoutes(app: Express): void {
  app.use("/api/locations", requireAuth);

  app.get("/api/locations", async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      res.json(await locationTree(orgId));
    } catch (err) {
      fail(res, err, "GET /api/locations");
    }
  });

  app.get("/api/locations/unassigned", async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const { cameras: cams, devices: devs } = await unassigned(orgId);
      // Camera secrets are decrypted on read; never echo them into a picker.
      res.json({
        cameras: cams.map((c) => ({ id: c.id, name: c.name, channelId: c.channelId })),
        devices: devs.map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
      });
    } catch (err) {
      fail(res, err, "GET /api/locations/unassigned");
    }
  });

  app.get("/api/locations/:id/breadcrumb", async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const trail = await breadcrumb(orgId, req.params.id);
      if (!trail.length) return res.status(404).json({ error: "Location not found" });
      res.json({ trail });
    } catch (err) {
      fail(res, err, "GET /api/locations/:id/breadcrumb");
    }
  });

  app.get("/api/locations/:id/cameras", async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const cams = await camerasInSubtree(orgId, req.params.id);
      res.json(cams.map(({ password, streamUrl, ...safe }) => safe));
    } catch (err) {
      fail(res, err, "GET /api/locations/:id/cameras");
    }
  });

  app.post("/api/locations", requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const body = createSchema.parse(req.body);
      const created = await createLocation(orgId, body);

      void audit(req, {
        action: "camera_created",
        organizationId: orgId,
        targetType: "location",
        targetId: created.id,
        targetLabel: created.name,
        detail: { kind: created.kind, parentId: created.parentId },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid location", details: err.errors });
      }
      fail(res, err, "POST /api/locations");
    }
  });

  app.patch("/api/locations/:id", requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const body = patchSchema.parse(req.body);

      // Re-parent first: it is the operation that can fail (cycle, depth), and
      // renaming after a rejected move would leave a half-applied edit.
      if (body.parentId !== undefined) {
        await moveLocation(orgId, req.params.id, body.parentId);
      }

      if (body.name !== undefined || body.kind !== undefined) {
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.kind !== undefined) patch.kind = body.kind;
        const updated = await db
          .update(locations)
          .set(patch)
          .where(and(eq(locations.id, req.params.id), eq(locations.organizationId, orgId)))
          .returning();
        if (!updated.length) return res.status(404).json({ error: "Location not found" });
      }

      const rows = await db
        .select()
        .from(locations)
        .where(and(eq(locations.id, req.params.id), eq(locations.organizationId, orgId)));
      if (!rows.length) return res.status(404).json({ error: "Location not found" });

      void audit(req, {
        action: "camera_updated",
        organizationId: orgId,
        targetType: "location",
        targetId: rows[0].id,
        targetLabel: rows[0].name,
        detail: { moved: body.parentId !== undefined, renamed: body.name !== undefined },
      });
      res.json(rows[0]);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid update", details: err.errors });
      }
      fail(res, err, "PATCH /api/locations/:id");
    }
  });

  app.delete("/api/locations/:id", requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });

      const rows = await db
        .select()
        .from(locations)
        .where(and(eq(locations.id, req.params.id), eq(locations.organizationId, orgId)));
      if (!rows.length) return res.status(404).json({ error: "Location not found" });

      await deleteLocation(orgId, req.params.id);
      void audit(req, {
        action: "camera_deleted",
        organizationId: orgId,
        targetType: "location",
        targetId: rows[0].id,
        targetLabel: rows[0].name,
      });
      res.json({ success: true });
    } catch (err) {
      fail(res, err, "DELETE /api/locations/:id");
    }
  });

  app.post("/api/locations/assign", requireWriteAccess, async (req, res) => {
    try {
      const orgId = resolveOrgScope(req);
      if (!orgId) return res.status(400).json({ error: "No organization context" });
      const body = assignSchema.parse(req.body);
      await assign(orgId, { type: body.type, id: body.id }, body.locationId);

      void audit(req, {
        action: "camera_updated",
        organizationId: orgId,
        targetType: body.type,
        targetId: body.id,
        detail: { locationId: body.locationId },
      });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid assignment", details: err.errors });
      }
      fail(res, err, "POST /api/locations/assign");
    }
  });
}
