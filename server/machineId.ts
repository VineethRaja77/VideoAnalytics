// server/machineId.ts
//
// A stable hardware fingerprint that binds an on-prem license to one machine.
// Derived from Linux's /etc/machine-id (persistent, unique per install) mixed
// with the primary MAC address, hashed so no raw identifiers leak. Falls back
// gracefully if a source is unavailable. An operator can override it with
// MACHINE_FINGERPRINT for VMs/containers where machine-id isn't stable.

import crypto from "crypto";
import fs from "fs";
import os from "os";

let cached: string | null = null;

function readMachineId(): string {
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return "";
}

function primaryMac(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") return ni.mac;
    }
  }
  return "";
}

export function getMachineFingerprint(): string {
  if (cached) return cached;
  if (process.env.MACHINE_FINGERPRINT) {
    cached = process.env.MACHINE_FINGERPRINT;
    return cached;
  }
  const material = `${readMachineId()}|${primaryMac()}|${os.arch()}`;
  cached = crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
  return cached;
}
