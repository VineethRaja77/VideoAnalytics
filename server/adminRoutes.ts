import { QuotaError } from "./quotaWrite";
// server/adminRoutes.ts
//
// Super-admin (platform/developer) API. Mounted under /api/admin with
// requireAuth + requireSuperAdmin already applied by the caller. This is
// where you manage client organizations, their users, the product catalog,
// and licensing (issue / suspend / expire / renew) per client per module.

import type { Express } from "express";
import { generateIngestToken, hashIngestToken } from "./crypto";
import { getModelReport } from "./modelRegistry";
import { z } from "zod";
import { audit } from "./audit";
import { clearOrgCache } from "./sensorMqtt";
import { storage } from "./storage";
import { hashPassword, validatePasswordStrength } from "./auth";
import { ROLES, FEATURE_MODULE, ANALYTICS_FEATURES } from "@shared/schema";
import { evaluateLicense } from "./entitlements";
import { limitsFor, usageFor, usageForAllOrgs } from "./limits";
import { onboardClient, OnboardingError } from "./onboarding";
import { regenerateSignedLicense } from "./licenseService";

const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric/dashes"),
});

/** Allowances. `null` clears a cap; a positive number sets one. */
const onboardSchema = z.object({
  name: z.string().trim().min(1, "The client needs a name."),
  slug: z.string().trim().optional(),
  adminEmail: z.string().trim().email("The administrator needs a valid email address."),
  adminUsername: z.string().trim().optional(),
  adminPassword: z.string().min(1, "Set an initial password for the administrator."),
  logoDataUrl: z.string().max(1_500_000).nullable().optional(),
  modules: z.array(z.string()).optional(),
  maxCameras: z.number().int().positive().nullable().optional(),
  maxUsers: z.number().int().positive().nullable().optional(),
  maxSites: z.number().int().positive().nullable().optional(),
  maxStorageGb: z.number().positive().nullable().optional(),
});

const limitsSchema = z.object({
  maxCameras: z.number().int().positive().nullable().optional(),
  maxUsers: z.number().int().positive().nullable().optional(),
  maxSites: z.number().int().positive().nullable().optional(),
  maxStorageGb: z.number().positive().nullable().optional(),
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
  limits: limitsSchema.optional(),
  // Bind the license to a specific on-prem machine (its fingerprint). Empty =
  // not machine-locked (cloud/trial).
  machineFingerprint: z.string().nullable().optional(),
});

/**
 * Roles the PLATFORM has any business touching.
 *
 * A client's managers and employees belong to the client. The platform owner
 * needs to create the first administrator (nobody else can), recover one who is
 * locked out, and disable one when a contract ends — and nothing beyond that.
 *
 * This was not enforced: GET /api/admin/users returned every user of every
 * organisation, and PATCH would reset a client EMPLOYEE's password, which
 * silently transfers their account to whoever runs the platform. Demonstrated
 * end to end before this guard existed: the employee's own password stopped
 * working and the platform's replacement worked.
 *
 * Operationally the platform loses nothing. A client admin resets their own
 * staff from Team Members, which is where that decision belongs.
 */
const PLATFORM_MANAGED_ROLES = new Set(["client_admin", "super_admin"]);

function refusePlatformReach(role: string | null | undefined): string | null {
  if (role && PLATFORM_MANAGED_ROLES.has(role)) return null;
  return (
    "This account belongs to a client's own team. Their administrator manages " +
    "it from Team Members — the platform does not."
  );
}

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

  /**
   * Take on a new client — organisation, administrator, licences and
   * allowances — in ONE action.
   *
   * The previous flow created only the organisation and told the operator to
   * "assign a client administrator next" on a different screen. An
   * organisation with no admin and no licence is indistinguishable from a
   * finished one in the client list, so the half-done state was invisible.
   * See server/onboarding.ts for why this is a transaction.
   */
  app.post("/api/admin/clients", async (req, res) => {
    try {
      const body = onboardSchema.parse(req.body);
      const result = await onboardClient({
        name: body.name,
        slug:
          body.slug?.trim() ||
          body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        adminEmail: body.adminEmail,
        adminUsername: body.adminUsername ?? "",
        adminPassword: body.adminPassword,
        logoDataUrl: body.logoDataUrl ?? null,
        modules: body.modules ?? [],
        limits: {
          maxCameras: body.maxCameras ?? null,
          maxUsers: body.maxUsers ?? null,
          maxSites: body.maxSites ?? null,
          maxStorageGb: body.maxStorageGb ?? null,
        },
      });

      void audit(req, {
        action: "organization_created",
        organizationId: result.organizationId,
        targetType: "organization",
        targetId: result.organizationId,
        targetLabel: body.name,
        detail: {
          adminEmail: body.adminEmail,
          modulesGranted: result.modulesGranted,
          modulesSkipped: result.modulesSkipped,
          limits: {
            maxCameras: body.maxCameras ?? null,
            maxUsers: body.maxUsers ?? null,
            maxSites: body.maxSites ?? null,
            maxStorageGb: body.maxStorageGb ?? null,
          },
        },
      });
      // The administrator is a separate auditable subject: "who was given
      // access to this client" is its own question.
      void audit(req, {
        action: "user_created",
        organizationId: result.organizationId,
        targetType: "user",
        targetId: result.adminId,
        targetLabel: body.adminEmail,
        detail: { role: "client_admin", viaOnboarding: true },
      });

      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0]?.message ?? "Invalid client" });
      }
      if (err instanceof OnboardingError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error("❌ POST /api/admin/clients failed:", err);
      res.status(500).json({ error: "Failed to create the client" });
    }
  });

  app.post("/api/admin/organizations", async (req, res) => {
    try {
      const body = createOrgSchema.parse(req.body);
      if (await storage.getOrganizationBySlug(body.slug)) {
        return res.status(409).json({ error: "Slug already in use" });
      }
      const org = await storage.createOrganization({ ...body, status: "active" });

      // Provision the BASE VMS licence with the organisation.
      //
      // Without it every camera route 403s, and the client signs in to an app
      // that says "No cameras added yet" on Live, "Add a camera first" on
      // Analytics Setup, and refuses to add one — with nothing anywhere saying
      // the licence is missing. A new client's first impression was a product
      // that looked broken, and the only fix was a super-admin action nothing
      // prompted for. The on-prem seed has always created this licence; cloud
      // org creation did not, which is the only reason the two behaved
      // differently.
      //
      // The analytics products stay opt-in — those are what is actually sold
      // per feature. `vms` is the thing without which nothing else can work.
      try {
        const base = await storage.getProductByKey("vms");
        if (base) {
          await storage.createLicense({
            organizationId: org.id,
            productId: base.id,
            plan: "perpetual",
            status: "active",
          } as any);
        } else {
          console.error(
            `❌ organisation "${org.slug}" created but the base "vms" product row ` +
              `is missing, so no licence could be issued. This client will see ` +
              `no cameras until it is created and a licence granted.`
          );
        }
      } catch (err) {
        // Never fail org creation over this — but say so loudly, because the
        // symptom the client sees is otherwise unexplained.
        console.error(
          `❌ organisation "${org.slug}" was created but its base VMS licence ` +
            `could not be issued. Grant it manually or the client will see no ` +
            `cameras:`,
          err
        );
      }

      void audit(req, {
        action: "organization_created",
        organizationId: org.id,
        targetType: "organization",
        targetId: org.id,
        targetLabel: org.name,
        detail: { slug: org.slug },
      });

      res.status(201).json(org);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: err.errors });
      console.error("❌ admin create-organization failed:", err);
      res.status(500).json({ error: "Failed to create organization" });
    }
  });

  app.patch("/api/admin/organizations/:id", async (req, res) => {
    try {
      const updates = z.object({ name: z.string().trim().min(1).max(160).optional(), logoDataUrl: z.string().max(1_500_000).nullable().optional(), status: z.enum(["active", "suspended"]).optional() }).strict().parse(req.body);
      const org = await storage.updateOrganization(req.params.id, updates);
      if (!org) return res.status(404).json({ error: "Organization not found" });
      void audit(req, { action: "organization_updated", organizationId: org.id, targetType: "organization", targetId: org.id, targetLabel: org.name, detail: updates });
      res.json(org);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Enter a valid client name and status." });
      res.status(500).json({ error: "Unable to update client." });
    }
  });


  /* ---------- MODULES (what a client may RUN) ---------- */

  /**
   * Every sellable module, with whether THIS client has it.
   *
   * Licensing was a flat table of the licences that happen to exist plus a
   * "grant" dialog — so to answer "what does Acme have?" you had to already
   * know what to look for, and to give them something you picked it out of a
   * dropdown one at a time. Neither view ever showed the modules a client does
   * NOT have, which is the half that matters when you are selling.
   */
  app.get("/api/admin/organizations/:id/modules", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });

      const [products, licences] = await Promise.all([
        storage.getAllProducts(),
        storage.getLicensesByOrg(org.id),
      ]);
      const byProduct = new Map(licences.map((l) => [l.productId, l]));

      res.json(
        products
          // The base VMS product is not an analytics module and is not
          // optional — revoking it leaves the client staring at an application
          // that says "no cameras" and refuses to add one.
          .filter((p) => p.key !== "vms" && (ANALYTICS_FEATURES as readonly string[]).includes(p.key))
          .map((p) => {
            const licence = byProduct.get(p.id);
            const check = licence ? evaluateLicense(licence, org) : null;
            // A revoked or expired row still EXISTS, so "a licence row is
            // present" is not the same question as "does this client have the
            // module". The toggle reflects the second one.
            const usable = !!licence && licence.status !== "revoked";
            return {
              key: p.key,
              name: p.name,
              module: FEATURE_MODULE[p.key] ?? null,
              granted: usable,
              active: check?.ok ?? false,
              reason: check && !check.ok ? check.reason : null,
              plan: licence?.plan ?? null,
              expiresAt: licence?.expiresAt ?? null,
              licenseId: licence?.id ?? null,
            };
          })
      );
    } catch (err) {
      console.error("❌ GET modules failed:", err);
      res.status(500).json({ error: "Failed to read modules" });
    }
  });

  /** Give this client one module. Idempotent: granting twice is not an error. */
  app.post("/api/admin/organizations/:id/modules/:key", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });
      const key = req.params.key;
      if (key === "vms") {
        return res.status(400).json({
          error: "Video Management is part of every client and cannot be granted separately.",
        });
      }
      const product = await storage.getProductByKey(key);
      if (!product) return res.status(404).json({ error: `Unknown module "${key}"` });
      if (!product.active) {
        return res.status(410).json({
          error: `"${product.name}" (${key}) has been retired and can no longer be granted.`,
        });
      }

      const existing = (await storage.getLicensesByOrg(org.id)).find(
        (l) => l.productId === product.id
      );
      if (existing) {
        // Re-granting a suspended or expired licence reactivates it rather than
        // creating a second row for the same module.
        await storage.updateLicense(existing.id, {
          status: "active",
          expiresAt: null,
        } as any);
      } else {
        await storage.createLicense({
          organizationId: org.id,
          productId: product.id,
          plan: "yearly",
          status: "active",
        } as any);
      }

      void audit(req, {
        action: "license_issued",
        organizationId: org.id,
        targetType: "license",
        targetId: product.id,
        targetLabel: `${org.name} · ${product.name}`,
        detail: { module: key, reactivated: !!existing },
      });
      res.json({ key, granted: true });
    } catch (err) {
      console.error("❌ grant module failed:", err);
      res.status(500).json({ error: "Failed to grant the module" });
    }
  });

  /**
   * Take one module away.
   *
   * The licence row is REVOKED, not deleted: "this client had face recognition
   * until March" is a commercial fact somebody will eventually need, and a
   * deleted row cannot answer it. The entitlement check treats revoked exactly
   * as it treats absent, so the client loses access immediately either way.
   */
  app.delete("/api/admin/organizations/:id/modules/:key", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });
      const key = req.params.key;
      if (key === "vms") {
        return res.status(400).json({
          error:
            "Video Management cannot be revoked on its own — suspend the client instead.",
        });
      }
      const product = await storage.getProductByKey(key);
      if (!product) return res.status(404).json({ error: `Unknown module "${key}"` });

      const existing = (await storage.getLicensesByOrg(org.id)).find(
        (l) => l.productId === product.id
      );
      if (!existing) return res.json({ key, granted: false });

      await storage.updateLicense(existing.id, { status: "revoked" } as any);

      void audit(req, {
        action: "license_revoked",
        organizationId: org.id,
        targetType: "license",
        targetId: existing.id,
        targetLabel: `${org.name} · ${product.name}`,
        detail: { module: key },
      });
      res.json({ key, granted: false });
    } catch (err) {
      console.error("❌ revoke module failed:", err);
      res.status(500).json({ error: "Failed to revoke the module" });
    }
  });

  /* ---------- LIMITS (what a client may CONSUME) ---------- */

  /**
   * Usage against allowance for every client, in one call.
   *
   * This is the platform overview's core question — "who is about to run out of
   * something I sold them?" — and answering it per-client would mean N requests
   * to render one screen.
   */
  app.get("/api/admin/usage", async (_req, res) => {
    try {
      res.json(await usageForAllOrgs());
    } catch (err) {
      console.error("❌ GET /api/admin/usage failed:", err);
      res.status(500).json({ error: "Failed to read platform usage" });
    }
  });

  app.get("/api/admin/organizations/:id/limits", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });
      res.json({ limits: await limitsFor(org.id), usage: await usageFor(org.id) });
    } catch (err) {
      console.error("❌ GET limits failed:", err);
      res.status(500).json({ error: "Failed to read limits" });
    }
  });

  /**
   * Set a client's allowances.
   *
   * Stored on the base `vms` licence, because a client has one camera
   * allowance — not one per analytics feature they happen to have bought.
   * Sending null for a key removes that cap (unlimited).
   */
  app.patch("/api/admin/organizations/:id/limits", async (req, res) => {
    try {
      const org = await storage.getOrganization(req.params.id);
      if (!org) return res.status(404).json({ error: "Organization not found" });

      const body = limitsSchema.parse(req.body);
      const licence = await storage.getEffectiveLicense(org.id, "vms");
      if (!licence) {
        return res.status(409).json({
          error:
            "This organisation has no base VMS licence, so there is nothing to " +
            "attach allowances to. Grant the VMS module first.",
        });
      }

      const current = (licence.limits ?? {}) as Record<string, unknown>;
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries({ ...current, ...body })) {
        // null / 0 / absent all mean "no cap", and are stored by omission so
        // the row never carries a limit that reads as zero-allowed.
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) next[k] = n;
      }

      await storage.updateLicense(licence.id, { limits: next, signedLicense: null } as any);

      void audit(req, {
        action: "license_updated",
        organizationId: org.id,
        targetType: "license",
        targetId: licence.id,
        targetLabel: `${org.name} allowances`,
        detail: { before: current, after: next },
      });

      res.json({ limits: next, usage: await usageFor(org.id) });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0]?.message ?? "Invalid limits" });
      }
      console.error("❌ PATCH limits failed:", err);
      res.status(500).json({ error: "Failed to update limits" });
    }
  });

  /* ---------- USERS (across all orgs) ---------- */
  app.get("/api/admin/users", async (req, res) => {
    const orgId = req.query.orgId as string | undefined;
    const users = orgId ? await storage.getUsersByOrg(orgId) : await storage.getAllUsers();
    // A client's managers and employees are not listed here. This used to
    // return every user of every organisation, so the platform owner could see
    // the whole of a client's staff directory for no operational reason.
    res.json(
      users
        .filter((u) => PLATFORM_MANAGED_ROLES.has(u.role))
        .map(({ passwordHash, ...u }) => u)
    );
  });

  app.post("/api/admin/users", async (req, res) => {
    try {
      const body = createUserSchema.parse(req.body);
      if (await storage.getUserByEmail(body.email)) {
        return res.status(409).json({ error: "Email already in use" });
      }
      // super_admin has no org; every client role must have one.
      // Creating a client's manager or employee is the client admin's job, in
      // their own Team Members screen. The platform only mints the FIRST
      // administrator, because nobody else can.
      const reachCreate = refusePlatformReach(body.role);
      if (reachCreate) return res.status(403).json({ error: reachCreate });

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
      if (err instanceof QuotaError) return res.status(403).json({ error: err.message });
      console.error("❌ admin create-user failed:", err);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.patch("/api/admin/users/:id", async (req, res) => {
    try {
      const before = await storage.getUser(req.params.id);
      if (!before) return res.status(404).json({ error: "User not found" });
      const reach = refusePlatformReach(before.role);
      if (reach) return res.status(403).json({ error: reach });

      if (req.params.id === req.user?.id && req.body.status === "disabled") return res.status(400).json({ error: "You cannot disable your own account." });
      if (req.body.password !== undefined) {
        const problem = validatePasswordStrength(String(req.body.password), before.username);
        if (problem) return res.status(400).json({ error: problem });
      }
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
      const reach = refusePlatformReach(victim.role);
      if (reach) return res.status(403).json({ error: reach });
      if (req.params.id === req.user?.id) return res.status(400).json({ error: "You cannot delete your own account." });
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
    res.json((await getModelReport()).modules);
  });

  /* ---------- PRODUCTS (module catalog) ---------- */
  app.get("/api/admin/products", async (_req, res) => {
    // Inactive products (retired keys kept only so old licence rows still have
    // a foreign key to point at) must never appear in a "grant this" list --
    // that is exactly how a client ended up licensed against a dead key whose
    // entitlement checks never look at it. See
    // scripts/retire-legacy-ppe-product.ts for the incident this closes.
    const products = await storage.getAllProducts();
    res.json(products.filter((p) => p.active));
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
        limits: body.limits ?? existing?.limits ?? null,
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
    try {
      const body = z.object({ status: z.enum(["active", "trial", "suspended", "expired"]).optional(), plan: z.enum(["monthly", "yearly", "trial", "perpetual"]).optional(), expiresAt: z.string().datetime().nullable().optional(), limits: limitsSchema.optional(), machineFingerprint: z.string().max(500).nullable().optional() }).parse(req.body);
      const updates = { ...body, ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}), signedLicense: null };
      const license = await storage.updateLicense(req.params.id, updates as any);
      if (!license) return res.status(404).json({ error: "License not found" });
      await regenerateSignedLicense(license.id);
      void audit(req, { action: "license_updated", organizationId: license.organizationId, targetType: "license", targetId: license.id, detail: body });
      res.json(await storage.getLicense(license.id));
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid license terms", details: err.errors });
      console.error("License update failed:", err);
      res.status(500).json({ error: "Unable to update license." });
    }
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
