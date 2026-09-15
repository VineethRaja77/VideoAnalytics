import { QuotaError } from "./quotaWrite";
// server/orgRoutes.ts
//
// Org-scoped administration for a client_admin: manage the managers and
// employees within THEIR OWN organization only. Mounted under /api/org with
// requireAuth applied; each route additionally enforces client_admin and
// hard-scopes every action to req.user.organizationId (tenant isolation).

import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage";
import { hashPassword, validatePasswordStrength } from "./auth";
import { audit } from "./audit";
import { requireRole } from "./rbac";
import { canAdd } from "./limits";

const createOrgUserSchema = z.object({
  username: z.string().min(1),
  email: z.string().email(),
  // Length is validated by validatePasswordStrength in the handler, not here:
  // a bare min(8) silently undercut the 12-character policy that
  // /api/admin/users and the seed both enforce, so a client_admin could mint
  // an account weaker than the platform's own rule.
  password: z.string().min(1),
  // A client_admin may only mint managers and employees, never admins/super.
  role: z.enum(["client_manager", "client_employee"]),
});

export function registerOrgRoutes(app: Express): void {
  const adminOnly = requireRole("client_admin");

  app.get("/api/org/users", adminOnly, async (req, res) => {
    const orgId = req.user!.organizationId!;
    const users = await storage.getUsersByOrg(orgId);
    res.json(users.map(({ passwordHash, ...u }) => u));
  });

  app.post("/api/org/users", adminOnly, async (req, res) => {
    try {
      const body = createOrgUserSchema.parse(req.body);
      const orgId = req.user!.organizationId!;
      if (await storage.getUserByEmail(body.email)) {
        return res.status(409).json({ error: "Email already in use" });
      }
      const weak = validatePasswordStrength(body.password, body.username);
      if (weak) return res.status(400).json({ error: weak });

      // maxUsers was written into every licence and read by nothing, so a
      // client sold "25 users" could create any number.
      const allowed = await canAdd(orgId, "maxUsers");
      if (!allowed.ok) return res.status(403).json({ error: allowed.message });

      const user = await storage.createUser({
        username: body.username,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        organizationId: orgId,
        role: body.role,
        status: "active",
      });
      const { passwordHash, ...safe } = user;
      // Audited like the super-admin path. Without this a client_admin could
      // add and remove accounts with no trail at all — the same actions are
      // recorded when a super_admin performs them, so the gap was arbitrary.
      void audit(req, {
        action: "user_created",
        organizationId: orgId,
        targetType: "user",
        targetId: user.id,
        targetLabel: user.username,
        detail: { role: user.role, email: user.email },
      });
      res.status(201).json(safe);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: err.errors });
      if (err instanceof QuotaError) return res.status(403).json({ error: err.message });
      console.error("❌ POST /api/org/users failed:", err);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.patch("/api/org/users/:id", adminOnly, async (req, res) => {
    const orgId = req.user!.organizationId!;
    const target = await storage.getUser(req.params.id);
    // Tenant isolation: can only touch users in your own org, and not yourself.
    if (!target || target.organizationId !== orgId) return res.status(404).json({ error: "User not found" });
    if (target.id === req.user!.id) return res.status(400).json({ error: "Cannot modify your own account here" });
    if (target.role === "client_admin") return res.status(403).json({ error: "Cannot modify another admin" });

    let statusChanged = false;
    if (req.body.status === "active" || req.body.status === "disabled") {
      await storage.setUserStatus(target.id, req.body.status);
      statusChanged = target.status !== req.body.status;
    }

    let passwordChanged = false;
    if (req.body.password !== undefined) {
      // Previously a short password was SILENTLY IGNORED and this still
      // returned 200 — the admin believed they had reset it while the old
      // password kept working. Same bug as /api/admin/users/:id had.
      const weak = validatePasswordStrength(String(req.body.password), target.username);
      if (weak) return res.status(400).json({ error: weak });
      await storage.updateUserPasswordHash(target.id, await hashPassword(String(req.body.password)));
      passwordChanged = true;
    }

    const updated = await storage.getUser(target.id);
    if (statusChanged) {
      void audit(req, {
        action: req.body.status === "disabled" ? "user_disabled" : "user_updated",
        organizationId: orgId,
        targetType: "user",
        targetId: target.id,
        targetLabel: target.username,
        detail: { status: req.body.status },
      });
    }
    if (passwordChanged) {
      void audit(req, {
        action: "password_changed",
        organizationId: orgId,
        targetType: "user",
        targetId: target.id,
        targetLabel: target.username,
        detail: { resetByOrgAdmin: true },
      });
    }
    const { passwordHash, ...safe } = updated!;
    res.json(safe);
  });

  app.delete("/api/org/users/:id", adminOnly, async (req, res) => {
    const orgId = req.user!.organizationId!;
    const target = await storage.getUser(req.params.id);
    if (!target || target.organizationId !== orgId) return res.status(404).json({ error: "User not found" });
    if (target.id === req.user!.id) return res.status(400).json({ error: "Cannot delete your own account" });
    if (target.role === "client_admin") return res.status(403).json({ error: "Cannot delete another admin" });
    await storage.deleteUser(target.id);
    void audit(req, {
      action: "user_disabled",
      organizationId: orgId,
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      detail: { deleted: true, role: target.role },
    });
    res.json({ success: true });
  });
}
