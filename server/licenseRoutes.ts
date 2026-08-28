// server/licenseRoutes.ts
//
// Public licensing endpoints (no session auth — on-prem installs call these
// during setup and phone-home, before any user logs in). Mounted at
// /api/license. These do NOT expose tenant data: fingerprint is a one-way
// hash of this box, and validate only answers for a licenseId the caller
// already holds (bound to a machine fingerprint).

import type { Express } from "express";
import { getMachineFingerprint } from "./machineId";
import { validatePhoneHome } from "./licenseService";
import { requireAuth } from "./auth";

export function registerLicenseRoutes(app: Express): void {
  // This machine's fingerprint — an operator reads it during on-prem setup so
  // the super admin can bind a license to this box.
  //
  // AUTHENTICATED: the fingerprint is the value a licence is bound to, so
  // handing it to any anonymous caller who can reach the box weakens the
  // binding. An operator doing on-prem setup is logged in; a stranger has no
  // reason to know it.
  app.get("/api/license/fingerprint", requireAuth, (_req, res) => {
    res.json({ machineFingerprint: getMachineFingerprint() });
  });

  // Phone-home: on-prem install checks live status + gets a refreshed token.
  app.post("/api/license/validate", async (req, res) => {
    try {
      const { licenseId, machineFingerprint } = req.body || {};
      if (!licenseId || !machineFingerprint) {
        return res.status(400).json({ error: "licenseId and machineFingerprint are required" });
      }
      const result = await validatePhoneHome(String(licenseId), String(machineFingerprint));
      res.json(result);
    } catch (err) {
      console.error("❌ POST /api/license/validate failed:", err);
      res.status(500).json({ error: "Validation failed" });
    }
  });
}
