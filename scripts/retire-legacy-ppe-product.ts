// scripts/retire-legacy-ppe-product.ts
//
// One-time repair for a real production defect, not a demo fixture.
//
// The product catalogue holds TWO rows named "PPE Compliance": the legacy key
// "ppe" and the current key "ppe_compliance". Every entitlement check in the
// app — the sidebar gate, requireModule(), the worker supervisor — reads the
// licence by the CURRENT key. Acme Corp's PPE licence was granted against the
// legacy row, so from the app's point of view they have no PPE licence at
// all: PPE Alerts is hidden from their sidebar and the PPE worker will not
// start, despite an active licence existing in the database.
//
// This migrates any organisation's USABLE legacy licence onto the current
// key (creating or reactivating it), REVOKES the legacy row so it cannot grant
// access twice, and marks the legacy product inactive so it can never be
// granted again from any dropdown.
//
//   npx tsx scripts/retire-legacy-ppe-product.ts           # dry run
//   npx tsx scripts/retire-legacy-ppe-product.ts --apply   # do it

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, storage } from "../server/storage";
import { licenses, products } from "@shared/schema";
import { evaluateLicense } from "../server/entitlements";

const APPLY = process.argv.includes("--apply");

async function main() {
  const legacy = await storage.getProductByKey("ppe");
  const current = await storage.getProductByKey("ppe_compliance");
  if (!legacy) {
    console.log('No legacy "ppe" product row exists. Nothing to do.');
    return;
  }
  if (!current) {
    console.error('❌ "ppe_compliance" does not exist — refusing to touch "ppe".');
    process.exit(1);
  }

  const legacyLicences = await db.select().from(licenses).where(eq(licenses.productId, legacy.id));
  console.log(`Found ${legacyLicences.length} licence row(s) on the legacy "ppe" product.\n`);

  for (const lic of legacyLicences) {
    const org = await storage.getOrganization(lic.organizationId);
    const usable = evaluateLicense(lic, org).ok;
    const orgLabel = `${org?.name ?? "(unknown org)"} (${lic.organizationId})`;

    if (!usable) {
      console.log(`  ${orgLabel}: legacy licence is ${lic.status} (not usable) — revoking only.`);
      if (APPLY) await storage.updateLicense(lic.id, { status: "revoked" } as any);
      continue;
    }

    const currentLic = (await storage.getLicensesByOrg(lic.organizationId)).find(
      (l) => l.productId === current.id
    );
    if (currentLic && evaluateLicense(currentLic, org).ok) {
      console.log(`  ${orgLabel}: already has a usable "ppe_compliance" licence — revoking the legacy one only.`);
      if (APPLY) await storage.updateLicense(lic.id, { status: "revoked" } as any);
      continue;
    }

    console.log(
      `  ${orgLabel}: MIGRATING — granting "ppe_compliance" (plan=${lic.plan}, ` +
        `expiresAt=${lic.expiresAt ?? "none"}) and revoking the legacy licence.`
    );
    if (APPLY) {
      if (currentLic) {
        await storage.updateLicense(currentLic.id, {
          status: lic.status,
          plan: lic.plan,
          expiresAt: lic.expiresAt,
          limits: lic.limits,
        } as any);
      } else {
        await storage.createLicense({
          organizationId: lic.organizationId,
          productId: current.id,
          plan: lic.plan,
          status: lic.status,
          expiresAt: lic.expiresAt,
          limits: lic.limits,
        } as any);
      }
      await storage.updateLicense(lic.id, { status: "revoked" } as any);
    }
  }

  console.log(`\nMarking the legacy "ppe" product inactive so it can never be granted again.`);
  if (APPLY) {
    await db.update(products).set({ active: false }).where(eq(products.id, legacy.id));
  }

  console.log(APPLY ? "\n✅ Applied." : "\nDry run only — re-run with --apply to make these changes.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("❌ migration failed:", err);
  process.exit(1);
});
