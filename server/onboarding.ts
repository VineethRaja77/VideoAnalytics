// server/onboarding.ts
//
// Taking on a new client, as ONE action.
//
// WHY THIS EXISTS
//   The customer account is the organization. Its administrator, logo, feature
//   entitlements and limits belong together, so the Super Admin wizard collects
//   them in one flow and this module provisions them in one action.
//
//   The old failure mode was silent: an organization with no administrator or
//   no usable licence looked identical to a finished account in the directory.
//   Nobody could sign in, nothing was licensed, and the console never said so.
//
// WHY IT IS A TRANSACTION
//   The steps are not independent. An organization whose admin failed to be
//   created is worse than no organization at all, because it occupies the slug
//   and looks done. Either the whole organization exists or none of it does.
//
//   That means writing through the transaction handle rather than the storage
//   layer, whose methods all close over the global connection.

import { eq, inArray } from "drizzle-orm";
import { db } from "./storage";
import { organizations, users, licenses, products } from "@shared/schema";
import { hashPassword, validatePasswordStrength } from "./auth";

export interface OnboardClientInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminUsername: string;
  adminPassword: string;
  logoDataUrl?: string | null;
  /** Licence FEATURE keys, e.g. ["intrusion", "face_recognition"]. */
  modules: string[];
  limits: {
    maxCameras?: number | null;
    maxUsers?: number | null;
    maxSites?: number | null;
    maxStorageGb?: number | null;
  };
}

export interface OnboardResult {
  organizationId: string;
  adminId: string;
  modulesGranted: string[];
  modulesSkipped: string[];
}

export class OnboardingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Only positive numbers are stored; anything else means "no cap". */
function cleanLimits(raw: OnboardClientInput["limits"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

export async function onboardClient(input: OnboardClientInput): Promise<OnboardResult> {
  const name = input.name?.trim();
  const slug = input.slug?.trim().toLowerCase();
  const adminEmail = input.adminEmail?.trim().toLowerCase();
  const adminUsername = input.adminUsername?.trim() || adminEmail?.split("@")[0];

  if (!name) throw new OnboardingError("The client needs a name.");
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new OnboardingError(
      "The identifier must be lowercase letters, numbers and dashes."
    );
  }
  if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new OnboardingError("The administrator needs a valid email address.");
  }
  // Checked here rather than only at the database, so the operator is told what
  // is wrong with the password before anything is created.
  const weak = validatePasswordStrength(input.adminPassword ?? "", adminUsername);
  if (weak) throw new OnboardingError(weak);

  // Uniqueness is re-checked inside the transaction, but checking first gives a
  // clear message instead of a constraint violation.
  if ((await db.select().from(organizations).where(eq(organizations.slug, slug))).length) {
    throw new OnboardingError(`The identifier "${slug}" is already in use.`, 409);
  }
  if ((await db.select().from(users).where(eq(users.email, adminEmail))).length) {
    throw new OnboardingError(`${adminEmail} already has an account.`, 409);
  }

  const wanted = [...new Set((input.modules ?? []).filter(Boolean))];
  // The base VMS licence is not optional and not a choice: without it every
  // camera route refuses the client and they see an empty, broken application.
  const needed = [...new Set(["vms", ...wanted])];

  const found = needed.length
    ? await db.select().from(products).where(inArray(products.key, needed))
    : [];
  const byKey = new Map(found.map((p) => [p.key, p]));
  if (!byKey.has("vms")) {
    throw new OnboardingError(
      'The base "vms" product is missing from the catalogue, so no client can be ' +
        "created. This is a platform seeding problem, not a data-entry one.",
      500
    );
  }
  // A module the catalogue does not know is reported back rather than silently
  // dropped — a client billed for something never granted is worse than an error.
  const skipped = wanted.filter((k) => !byKey.has(k));
  const granted = wanted.filter((k) => byKey.has(k));

  const passwordHash = await hashPassword(input.adminPassword);
  const limits = cleanLimits(input.limits);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name, slug, status: "active", logoDataUrl: input.logoDataUrl ?? null } as any)
      .returning();

    const [admin] = await tx
      .insert(users)
      .values({
        username: adminUsername,
        email: adminEmail,
        passwordHash,
        organizationId: org.id,
        role: "client_admin",
        status: "active",
      })
      .returning();

    // Base licence carries the allowances — a client has one camera allowance,
    // not one per feature they happen to have bought.
    await tx.insert(licenses).values({
      organizationId: org.id,
      productId: byKey.get("vms")!.id,
      plan: "perpetual",
      status: "active",
      limits,
    } as any);

    for (const key of granted) {
      if (key === "vms") continue;
      await tx.insert(licenses).values({
        organizationId: org.id,
        productId: byKey.get(key)!.id,
        plan: "yearly",
        status: "active",
      } as any);
    }

    return {
      organizationId: org.id,
      adminId: admin.id,
      modulesGranted: granted.filter((k) => k !== "vms"),
      modulesSkipped: skipped,
    };
  });
}
