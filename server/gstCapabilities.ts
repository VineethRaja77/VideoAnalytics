// server/gstCapabilities.ts
import { execFile } from "child_process";

export type GpuVendor = "nvidia" | "vaapi" | "none";

const GST_INSPECT_PATH = process.env.GST_INSPECT_PATH || "gst-inspect-1.0";

function elementExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(GST_INSPECT_PATH, [name], (err) => resolve(!err));
  });
}

let cached: GpuVendor | null = null;

export async function detectGpuVendor(): Promise<GpuVendor> {
  if (cached !== null) return cached;

  const [hasNvDec, hasNvEnc] = await Promise.all([
    elementExists("nvh265dec"),
    elementExists("nvh264enc"),
  ]);
  if (hasNvDec && hasNvEnc) {
    cached = "nvidia";
    return cached;
  }

  const [hasVaDec, hasVaEnc] = await Promise.all([
    elementExists("vah265dec"),
    elementExists("vah264enc"),
  ]);
  if (hasVaDec && hasVaEnc) {
    cached = "vaapi";
    return cached;
  }

  cached = "none";
  return cached;
}

export function getCachedGpuVendor(): GpuVendor | null {
  return cached;
}
