// server/seed.ts
//
// Idempotent boot seeding, driven by DEPLOYMENT_MODE:
//   cloud  → ensure the platform super_admin exists (you/the developer).
//   onprem → ensure one client org + a client_admin + an active VMS license.
// Always ensures the `vms` product row exists so licenses can reference it.

import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { storage, backfillCameraEncryption } from "./storage";
import { ANALYTICS_FEATURES, FEATURE_LABELS, FEATURE_MODULE } from "@shared/schema";

/**
 * A misconfiguration fatal enough that booting anyway would be unsafe (e.g. a
 * default admin password in production). seedPlatform deliberately swallows
 * ordinary seed failures so a transient DB hiccup does not block startup — this
 * type is re-thrown so it cannot be swallowed with them.
 */
class ConfigError extends Error {}

async function hash(pw: string) {
  return bcrypt.hash(pw, 12);
}

async function ensureProducts() {
  // The VMS core itself.
  await storage.upsertProduct({
    key: "vms",
    name: "Video Management System",
    description: "Live view, recording, and playback for IP cameras",
    active: true,
  });

  // One product per ANALYTICS FEATURE, not per module. A client buying only
  // intrusion must not receive loitering, crowd density and the rest just
  // because one `person` worker happens to provide them all.
  // Iterate the FEATURE LIST, not the label map. A feature added to
  // MODULE_FEATURES but forgotten in FEATURE_LABELS would otherwise get no
  // product row, and the only symptom is a permanent "not licensed for this
  // feature" that no admin action can fix — the licence cannot even be issued.
  for (const feature of ANALYTICS_FEATURES) {
    const label = FEATURE_LABELS[feature];
    if (!label) {
      console.warn(
        `⚠ feature "${feature}" has no entry in FEATURE_LABELS — using the raw key ` +
          `as its product name. Add a label so the admin console reads properly.`
      );
    }
    const name = label ?? feature;
    await storage.upsertProduct({
      key: feature,
      name,
      description: `${name} — provided by the "${FEATURE_MODULE[feature]}" module`,
      active: true,
    });
  }
}

async function ensureSuperAdmin() {
  const all = await storage.getAllUsers();
  if (all.some((u) => u.role === "super_admin")) return;

  const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@hyperspark.local";
  const username = process.env.SUPER_ADMIN_USERNAME || "superadmin";

  // A hard-coded default password on a box the client installs is a known-
  // credential root account. In production we refuse to boot without an
  // explicit one; in development we generate a random password and print it
  // once, so there is never a guessable default anywhere.
  let password = process.env.SUPER_ADMIN_PASSWORD || "";
  let generated = false;

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      throw new ConfigError(
        "SUPER_ADMIN_PASSWORD must be set on first boot in production — " +
          "refusing to create a super_admin with a default password."
      );
    }
    password = randomBytes(18).toString("base64url");
    generated = true;
  } else if (password.length < 12) {
    throw new ConfigError("SUPER_ADMIN_PASSWORD must be at least 12 characters");
  }

  await storage.createUser({
    username,
    email,
    passwordHash: await hash(password),
    organizationId: null,
    role: "super_admin",
    status: "active",
  });
  console.log(`👑 Platform super_admin created (${email})`);
  if (generated) {
    console.log(
      `🔑 Generated one-time super_admin password: ${password}\n` +
        "   Save it now and change it after first login — it is not stored anywhere in plaintext."
    );
  }
}

async function ensureOnPremOrgAndAdmin() {
  const slug = process.env.ONPREM_ORG_SLUG || "site";
  let org = await storage.getOrganizationBySlug(slug);
  if (!org) {
    org = await storage.createOrganization({
      name: process.env.ONPREM_ORG_NAME || "On-Prem Site",
      slug,
      status: "active",
    });
    console.log(`🏢 On-prem organization created: ${org.name}`);
  }

  const users = await storage.getUsersByOrg(org.id);
  if (!users.some((u) => u.role === "client_admin")) {
    const email = process.env.ONPREM_ADMIN_EMAIL || "admin@site.local";

    // This is the account that actually ships on a client's box, so a
    // hard-coded "admin123" is the most exposed credential in the system.
    // Same rule as super_admin: explicit in production, random otherwise.
    let password = process.env.ONPREM_ADMIN_PASSWORD || "";
    let generated = false;
    if (!password) {
      if (process.env.NODE_ENV === "production") {
        throw new ConfigError(
          "ONPREM_ADMIN_PASSWORD must be set on first boot — refusing to create " +
            "a client admin with a default password."
        );
      }
      password = randomBytes(18).toString("base64url");
      generated = true;
    } else if (password.length < 12) {
      throw new ConfigError("ONPREM_ADMIN_PASSWORD must be at least 12 characters");
    }

    await storage.createUser({
      username: process.env.ONPREM_ADMIN_USERNAME || "admin",
      email,
      passwordHash: await hash(password),
      organizationId: org.id,
      role: "client_admin",
      status: "active",
    });
    console.log(`👤 On-prem client_admin created (${email})`);
    if (generated) {
      console.log(
        `🔑 Generated one-time client_admin password: ${password}\n` +
          "   Save it now and change it after first login."
      );
    }
  }

  // Ensure an active VMS license for the site (real signed license comes in Phase 2).
  const existing = await storage.getEffectiveLicense(org.id, "vms");
  if (!existing) {
    const product = await storage.getProductByKey("vms");
    if (product) {
      await storage.createLicense({
        organizationId: org.id,
        productId: product.id,
        plan: "perpetual",
        status: "active",
        limits: { maxCameras: 1000, maxUsers: 50 },
      });
      console.log("📜 On-prem VMS license created (active)");
    }
  }
}

export async function seedPlatform(): Promise<void> {
  await backfillCameraEncryption();
  try {
    await ensureProducts();
    const mode = (process.env.DEPLOYMENT_MODE || "cloud").toLowerCase();
    if (mode === "onprem") {
      await ensureOnPremOrgAndAdmin();
    } else {
      await ensureSuperAdmin();
    }
    console.log(`✅ Platform seed complete (mode=${mode})`);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n🛑 REFUSING TO START: ${err.message}\n`);
      throw err;
    }
    console.error("❌ Platform seed failed:", err);
  }
}
