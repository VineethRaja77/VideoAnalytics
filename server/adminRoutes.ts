// server/adminRoutes.ts
//
// Super-admin (platform/developer) API. Mounted under /api/admin with
// requireAuth + requireSuperAdmin already applied by the caller. This is
// where you manage client organizations, their users, the product catalog,
// and licensing (issue / suspend / expire / renew) per client per module.

import type { Express } from "express";
import { generateIngestToken, hashIngestToken } from "./crypto";
import { verifyAllModules } from "./modelRegistry";
import { z } from "zod";
import { audit } from "./audit";
import { clearOrgCache } from "./sensorMqtt";
import { storage } from "./storage";
import { hashPassword, validatePasswordStrength } from "./auth";
import { ROLES } from "@shared/schema";
import { evaluateLicense } from "./entitlements";
import { regenerateSignedLicense } from "./licenseService";

const createOrgSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric/dashes"),
});

const createUserSchema = z.object({
  username: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  organizationId: z.string().nullable().optional(),
  role: z.enum(ROLES),
});

const issueLicenseSchema = z.object({
  organizationId: z.string().min(1),
  productKey: z.string().min(1),
  plan: z.enum(["monthly", "yearly", "trial", "perpetual"]).default("trial"),
  status: z.enum(["active", "suspended", "expired", "trial"]).default("active"),
  expiresAt: z.string().datetime().nullable().optional(),
  limits: z.record(z.any()).optional(),
  // Bind the license to a specific on-prem machine (its fingerprint). Empty =
  // not machine-locked (cloud/trial).
  machineFingerprint: z.string().nullable().optional(),
});

export function registerAdminRoutes(app: Express): void {
  /* ---------- ORGANIZATIONS ---------- */
  app.get("/api/admin/organizations", async (_req, res) => {
    const orgs = await storage.getAllOrganizations();
    const licenses = await storage.getAllLicenses();
    const products = await storage.getAllProducts();
    const keyById = new Map(products.map((p) => [p.id, p.key]));
    const enriched = orgs.map((o) => ({
      ...o,
      modules: licenses
        .filter((l) => l.organizationId === o.id)
        .map((l) => ({
          key: keyById.get(l.productId),
          status: l.status,
          plan: l.plan,
          expiresAt: l.expiresAt,
          valid: evaluateLicense(l, o).ok,
        })),
    }));
    res.json(enriched);
  });

  app.post("/api/admin/organizations", async (req, res) => {
    try {
      const body = createOrgSchema.parse(req.body);
      if (await storage.getOrganizationBySlug(body.slug)) {
        return res.status(409).json({ error: "Slug already in use" });
      }
      const org = await storage.createOrganization({ ...body, status: "active" });
      res.status(201).json(org);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: err.errors });
      console.error("❌ admin create-organization failed:", err);
      res.status(500).json({ error: "Failed to create organization" });
    }
  });

  app.patch("/api/admin/organizations/:id", async (req, res) => {
    const updates: any = {};
    if (typeof req.body.name === "string") updates.name = req.body.name;
    if (req.body.status === "active" || req.body.status === "suspended") updates.status = req.body.status;
    const org = await storage.updateOrganization(req.params.id, updates);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json(org);
  });

  /* ---------- USERS (across all orgs) ---------- */
  app.get("/api/admin/users", async (req, res) => {
    const orgId = req.query.orgId as string | undefined;
    const users = orgId ? await storage.getUsersByOrg(orgId) : await storage.getAllUsers();
    res.json(users.map(({ passwordHash, ...u }) => u));
  });

  app.post("/api/admin/users", async (req, res) => {
    try {
      const body = createUserSchema.parse(req.body);
      if (await storage.getUserByEmail(body.email)) {
        return res.status(409).json({ error: "Email already in use" });
      }
      // super_admin has no org; every client role must have one.
      const organizationId = body.role === "super_admin" ? null : body.organizationId ?? null;
      if (body.role !== "super_admin" && !organizationId) {
        return res.status(400).json({ error: "organizationId is required for client roles" });
      }
      const weak = validatePasswordStrength(body.password, body.username);
      if (weak) return res.status(400).json({ error: weak });

      const user = await storage.createUser({
        username: body.username,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        organizationId,
        role: body.role,
        status: "active",
      });
      const { passwordHash, ...safe } = user;
      void audit(req, {
        action: "user_created",
        organizationId,
        targetType: "user",
        targetId: user.id,
        targetLabel: user.username,
        detail: { role: user.role, email: user.email },
      });
      res.status(201).json(safe);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: err.errors });
      console.error("❌ admin create-user failed:", err);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.patch("/api/admin/users/:id", async (req, res) => {
    try {
      const before = await storage.getUser(req.params.id);
      if (!before) return res.status(404).json({ error: "User not found" });

      let statusChanged = false;
      let passwordChanged = false;

      if (req.body.status === "active" || req.body.status === "disabled") {
        await storage.setUserStatus(req.params.id, req.body.status);
        statusChanged = before.status !== req.body.status;
      }

      if (req.body.password !== undefined) {
        // Previously a short password was silently ignored and the endpoint
        // still returned 200 — an admin would believe they had reset it while
        // the old password kept working. Reject explicitly instead.
        const problem = validatePasswordStrength(String(req.body.password));
        if (problem) return res.status(400).json({ error: problem });
        await storage.updateUserPasswordHash(req.params.id, await hashPassword(String(req.body.password)));
        passwordChanged = true;
      }

      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });

      if (statusChanged) {
        void audit(req, {
          action: req.body.status === "disabled" ? "user_disabled" : "user_updated",
          organizationId: user.organizationId,
          targetType: "user",
          targetId: user.id,
          targetLabel: user.username,
          detail: { status: req.body.status },
        });
      }
      if (passwordChanged) {
        void audit(req, {
          action: "password_changed",
          organizationId: user.organizationId,
          targetType: "user",
          targetId: user.id,
          targetLabel: user.username,
          detail: { resetByAdmin: true },
        });
      }

      const { passwordHash, ...safe } = user;
      res.json(safe);
    } catch (err) {
      console.error("❌ admin update-user failed:", err);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/admin/users/:id", async (req, res) => {
    try {
      // Read before deleting: the audit row must name who was removed, and
      // after the delete there is nothing left to name them by.
      const victim = await storage.getUser(req.params.id);
      if (!victim) return res.status(404).json({ error: "User not found" });
      await storage.deleteUser(req.params.id);
      void audit(req, {
        action: "user_disabled",
        organizationId: victim.organizationId,
        targetType: "user",
        targetId: victim.id,
        targetLabel: victim.username,
        detail: { deleted: true, role: victim.role },
      });
      res.json({ success: true });
    } catch (err) {
      console.error("❌ admin delete-user failed:", err);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  /* ---------- MODEL ARTIFACTS ---------- */
  // Answers "is the right model actually deployed on this box?" — presence,
  // size and SHA-256 against models/manifest.json.
  app.get("/api/admin/models/status", async (_req, res) => {
    res.json(verifyAllModules());
  });

  /* ---------- PRODUCTS (module catalog) ---------- */
  app.get("/api/admin/products", async (_req, res) => {
    res.json(await storage.getAllProducts());
  });

  /* ---------- LICENSES ---------- */
  app.get("/api/admin/licenses", async (req, res) => {
    const orgId = req.query.orgId as string | undefined;
    const licenses = orgId ? await storage.getLicensesByOrg(orgId) : await storage.getAllLicenses();
    const products = await storage.getAllProducts();
    const keyById = new Map(products.map((p) => [p.id, p.key]));
    res.json(licenses.map((l) => ({ ...l, productKey: keyById.get(l.productId) })));
  });

  app.post("/api/admin/licenses", async (req, res) => {
    try {
      const body = issueLicenseSchema.parse(req.body);
      const product = await storage.getProductByKey(body.productKey);
      if (!product) return res.status(400).json({ error: `Unknown product: ${body.productKey}` });
      if (!(await storage.getOrganization(body.organizationId))) {
        return res.status(400).json({ error: "Unknown organization" });
      }
      // One license per (org, product) — update if it already exists.
      const existing = await storage.getEffectiveLicense(body.organizationId, body.productKey);
      const values = {
        organizationId: body.organizationId,
        productId: product.id,
        plan: body.plan,
        status: body.status,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        limits: body.limits ?? null,
        machineFingerprint: body.machineFingerprint ?? null,
      };
      const license = existing
        ? await storage.updateLicense(existing.id, values)
        : await storage.createLicense(values);
      // Sign the portable license token (the downloadable .lic contract),
      // then return the row reflecting the stored signed token.
      if (license) await regenerateSignedLicense(license.id);
      const fresh = license ? await storage.getLicense(license.id) : license;
      void audit(req, {
        action: existing ? "license_updated" : "license_issued",
        organizationId: body.organizationId,
        targetType: "license",
        targetId: fresh?.id ?? null,
        targetLabel: body.productKey,
        // Which features a client bought is exactly what a billing dispute
        // turns on, so the limits and plan are recorded in full.
        detail: { product: body.productKey, plan: body.plan, status: body.status, limits: body.limits ?? null, expiresAt: body.expiresAt ?? null },
      });
      res.status(201).json(fresh);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: err.errors });
      console.error("❌ admin issue-license failed:", err);
      res.status(500).json({ error: "Failed to issue license" });
    }
  });

  app.patch("/api/admin/licenses/:id", async (req, res) => {
    const updates: any = {};
    if (["active", "suspended", "expired", "trial"].includes(req.body.status)) updates.status = req.body.status;
    if (["monthly", "yearly", "trial", "perpetual"].includes(req.body.plan)) updates.plan = req.body.plan;
    if (req.body.expiresAt === null) updates.expiresAt = null;
    else if (typeof req.body.expiresAt === "string") updates.expiresAt = new Date(req.body.expiresAt);
    if (req.body.limits && typeof req.body.limits === "object") updates.limits = req.body.limits;
    if (typeof req.body.machineFingerprint === "string" || req.body.machineFingerprint === null) {
      updates.machineFingerprint = req.body.machineFingerprint;
    }

    const license = await storage.updateLicense(req.params.id, updates);
    if (!license) return res.status(404).json({ error: "License not found" });
    // Re-sign so the .lic contract reflects the new terms.
    await regenerateSignedLicense(license.id);
    res.json(license);
  });

  // Download the signed .lic file to install on the client's on-prem box.
  app.get("/api/admin/licenses/:id/file", async (req, res) => {
    const license = await storage.getLicense(req.params.id);
    if (!license) return res.status(404).json({ error: "License not found" });
    let token = license.signedLicense;
    if (!token) token = await regenerateSignedLicense(license.id);
    if (!token) return res.status(500).json({ error: "Could not sign license" });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="license-${license.id.slice(0, 8)}.lic"`);
    res.send(token);
  });

  app.delete("/api/admin/licenses/:id", async (req, res) => {
    try {
      const before = await storage.getLicense(req.params.id);
      if (!before) return res.status(404).json({ error: "License not found" });
      await storage.deleteLicense(req.params.id);
      void audit(req, {
        action: "license_revoked",
        organizationId: before.organizationId,
        targetType: "license",
        targetId: before.id,
        detail: { plan: before.plan, status: before.status },
      });
      res.json({ success: true });
    } catch (err) {
      console.error("❌ admin delete-license failed:", err);
      res.status(500).json({ error: "Failed to delete license" });
    }
  });

  /**
   * Mint (or rotate) an organization's analytics ingest token.
   *
   * The token is returned ONCE — only its hash is stored, so it cannot be read
   * back later. Rotating immediately invalidates the previous token, which is
   * the revocation path if a client site is compromised.
   */
  app.post("/api/admin/organizations/:id/ingest-token", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });

      const token = generateIngestToken();
      await storage.setOrgIngestKeyHash(org.id, hashIngestToken(token));

      // Rotation IS the revocation path ("if a client site is compromised"),
      // so the MQTT bridge's token->org cache must be dropped immediately.
      // Without this the OLD token kept authenticating sensor traffic for up to
      // the cache TTL after it was revoked.
      clearOrgCache();

      // The TOKEN IS NEVER AUDITED — only the fact that it was rotated. It is
      // a bearer credential; a copy in the audit table would be readable by
      // every admin and auditor forever.
      void audit(req, {
        action: "ingest_token_minted",
        organizationId: org.id,
        targetType: "organization",
        targetId: org.id,
        targetLabel: org.name,
        detail: { rotated: true },
      });

      res.json({
        organizationId: org.id,
        token,
        note: "Store this now — it is not retrievable. Set it as ANALYTICS_INGEST_KEY on that organization's worker host.",
      });
    } catch (err) {
      console.error("❌ admin mint-ingest-token failed:", err);
      res.status(500).json({ error: "Failed to mint token" });
    }
  });
}
