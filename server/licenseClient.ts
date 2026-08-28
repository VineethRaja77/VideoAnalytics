// server/licenseClient.ts
//
// Deployment-mode-aware licensing bootstrap.
//
//   cloud  → this box IS the authority: generate/load the signing keypair.
//   onprem → this box is a CONSUMER: it does NOT trust its own local DB for
//            entitlement (the client controls that box). Instead it verifies
//            a cryptographically SIGNED license file with the embedded public
//            key, checks the machine binding + expiry offline, and phones home
//            to the cloud authority on a schedule to pick up suspend/revoke.
//            A grace window keeps it working through short outages; once the
//            signed expiry passes or the authority says suspended/revoked (or
//            grace runs out), the module is disabled.

import fs from "fs";
import path from "path";
import { ensureSigningKeys, loadPublicKey, verifyLicense, type LicensePayload } from "./licenseCrypto";
import { getMachineFingerprint } from "./machineId";

const MODE = (process.env.DEPLOYMENT_MODE || "cloud").toLowerCase();
const LICENSE_FILE = process.env.LICENSE_FILE || path.join(process.env.LICENSE_KEY_DIR || "/etc/vms", "license.lic");
const AUTHORITY_URL = process.env.LICENSE_AUTHORITY_URL || ""; // e.g. https://vms.hyperspark.in
const PHONE_HOME_INTERVAL_MS = Number(process.env.LICENSE_PHONE_HOME_MS || 60 * 60 * 1000); // hourly
const GRACE_MS = Number(process.env.LICENSE_GRACE_MS || 7 * 24 * 60 * 60 * 1000); // 7 days offline

export interface LocalEntitlement {
  valid: boolean;
  status: string;
  reason?: string;
  expiresAt: string | null;
}

// productKey -> current local entitlement (onprem only)
const localState = new Map<string, LocalEntitlement>();
let lastAuthoritySuccess = 0;

export function isOnPrem(): boolean {
  return MODE === "onprem";
}

export function getLocalEntitlement(productKey: string): LocalEntitlement {
  return localState.get(productKey) ?? { valid: false, status: "unlicensed", reason: "no_license", expiresAt: null };
}

/** Verify the signed license file offline and set the local entitlement. */
function loadSignedLicenseFile(): LicensePayload | null {
  if (!fs.existsSync(LICENSE_FILE)) {
    console.error(`❌ No license file at ${LICENSE_FILE} — modules will be disabled`);
    return null;
  }
  const token = fs.readFileSync(LICENSE_FILE, "utf8").trim();
  const res = verifyLicense(token);
  if (!res.ok || !res.payload) {
    console.error(`❌ License file failed verification: ${res.reason}`);
    return null;
  }
  const p = res.payload;
  const machineOk = !p.machineFingerprint || p.machineFingerprint === getMachineFingerprint();
  const notExpired = !p.expiresAt || new Date(p.expiresAt).getTime() > Date.now();
  const statusOk = p.status === "active" || p.status === "trial";

  localState.set(p.productKey, {
    valid: machineOk && notExpired && statusOk,
    status: p.status,
    reason: !machineOk ? "machine_mismatch" : !notExpired ? "expired" : !statusOk ? p.status : undefined,
    expiresAt: p.expiresAt,
  });
  console.log(
    `📜 License loaded: ${p.productKey} for ${p.organizationName} — ` +
      `${machineOk ? "machine ✓" : "MACHINE MISMATCH"}, ${notExpired ? "not expired" : "EXPIRED"}, status=${p.status}`
  );
  return p;
}

/** Phone home to refresh live status (suspend/revoke) and the signed token. */
async function phoneHome(payload: LicensePayload): Promise<void> {
  if (!AUTHORITY_URL) return; // fully offline install — rely on the signed file only
  try {
    const res = await fetch(`${AUTHORITY_URL}/api/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseId: payload.licenseId, machineFingerprint: getMachineFingerprint() }),
    });
    if (!res.ok) throw new Error(`authority ${res.status}`);
    const data = await res.json();
    lastAuthoritySuccess = Date.now();

    // Persist a refreshed token so the offline fallback stays current.
    if (data.token) fs.writeFileSync(LICENSE_FILE, data.token, { mode: 0o644 });

    const cur = localState.get(payload.productKey);
    localState.set(payload.productKey, {
      valid: !!data.valid,
      status: data.status ?? cur?.status ?? "unknown",
      reason: data.valid ? undefined : data.reason,
      expiresAt: cur?.expiresAt ?? payload.expiresAt,
    });
    console.log(`📡 Phone-home ok: ${payload.productKey} valid=${data.valid} status=${data.status}`);
  } catch (err) {
    // Outage: keep working until the grace window closes.
    const withinGrace = Date.now() - (lastAuthoritySuccess || Date.now()) < GRACE_MS;
    if (!withinGrace) {
      const cur = localState.get(payload.productKey);
      if (cur) localState.set(payload.productKey, { ...cur, valid: false, reason: "authority_unreachable_grace_expired" });
      console.error("❌ Phone-home failed and grace period expired — disabling module");
    } else {
      console.warn("⚠ Phone-home failed; still within grace period");
    }
  }
}

export async function initLicensing(): Promise<void> {
  if (!isOnPrem()) {
    // Cloud authority: make sure the signing keypair exists.
    const { publicKeyPem } = ensureSigningKeys();
    console.log("🔑 License authority ready (public key available for on-prem installs)");
    void publicKeyPem;
    return;
  }

  // On-prem consumer:
  loadPublicKey();
  const payload = loadSignedLicenseFile();
  if (payload) {
    lastAuthoritySuccess = Date.now(); // start the grace clock optimistically
    await phoneHome(payload);
    setInterval(() => void phoneHome(payload), PHONE_HOME_INTERVAL_MS);
  }
}
