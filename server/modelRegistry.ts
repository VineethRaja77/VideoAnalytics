// server/modelRegistry.ts
//
// Verifies that the AI model artifacts on this host are the ones we shipped.
//
// Without this, a module can be licensed and its worker can start while the
// weight file is missing, truncated by a failed copy, or silently swapped —
// and the first symptom is bad detections in production, not an error. The
// registry pins each module's required files with a SHA-256 so "is the right
// model deployed?" is answerable rather than assumed.
//
// Hashes are recorded per install (models are large and are not in git). Run
//   npx tsx server/modelRegistry.ts --record
// after deploying weights to write models/manifest.json, then ship that file
// with the release; later boots verify against it.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const MODELS_BASE = process.env.MODELS_BASE || path.join(process.cwd(), "models");
const MANIFEST_PATH = path.join(MODELS_BASE, "manifest.json");

/** Files each module needs in order to run at all. */
export const REQUIRED_ARTIFACTS: Record<string, string[]> = {
  // RF-DETR Small (Apache-2.0) exported to ONNX, one model for people AND PPE.
  // Replaced the YOLO-pose + two-model ensemble, which was AGPL-3.0.
  ppe: ["weights/ppe_rfdetr.onnx"],
  // RF-DETR Small (Apache-2.0) exported to ONNX. Replaced the YOLO11
  // vehicle_best.pt, which was AGPL-3.0 and could not ship commercially.
  vehicle: ["weights/vehicle_rfdetr.onnx"],
  face: ["weights/auraface_glintr100.onnx", "weights/face_detection_yunet_2023mar.onnx"],
  // COCO-pretrained RF-DETR — nothing was trained for this module; `person`
  // is COCO class 1 in the stock Apache-2.0 checkpoint.
  person: ["weights/person_rfdetr.onnx"],
  // No artifacts at all: tamper detection is pure image statistics. An empty
  // list verifies as ok, which is correct — there is nothing to checksum.
  tamper: [],
  // Also model-free: dual background subtraction + an edge test.
  object: [],
};

export interface ArtifactCheck {
  file: string;
  present: boolean;
  sha256?: string;
  expected?: string;
  matches?: boolean;
  sizeBytes?: number;
}

export interface ModuleCheck {
  module: string;
  ok: boolean;
  reason?: string;
  artifacts: ArtifactCheck[];
}

function sha256File(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function loadManifest(): Record<string, Record<string, string>> {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.error("❌ models/manifest.json is unreadable:", err);
    return {};
  }
}

/**
 * Verify one module's artifacts.
 *
 * A module with no manifest entry is reported present-but-unverified rather
 * than failed: an install that predates the manifest should still run, it just
 * cannot prove which weights it has.
 */
export function verifyModule(module: string): ModuleCheck {
  const required = REQUIRED_ARTIFACTS[module];
  if (!required) return { module, ok: false, reason: "unknown module", artifacts: [] };

  const manifest = loadManifest()[module] ?? {};
  const dir = path.join(MODELS_BASE, module);
  const artifacts: ArtifactCheck[] = [];
  let ok = true;

  for (const rel of required) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      artifacts.push({ file: rel, present: false });
      ok = false;
      continue;
    }
    const sha256 = sha256File(full);
    const expected = manifest[rel];
    const matches = expected ? sha256 === expected : undefined;
    if (matches === false) ok = false;
    artifacts.push({
      file: rel,
      present: true,
      sha256,
      expected,
      matches,
      sizeBytes: fs.statSync(full).size,
    });
  }

  const missing = artifacts.filter((a) => !a.present).length;
  const mismatched = artifacts.filter((a) => a.matches === false).length;
  const reason = missing
    ? `${missing} artifact(s) missing`
    : mismatched
      ? `${mismatched} artifact(s) failed checksum`
      : undefined;

  return { module, ok, reason, artifacts };
}

export function verifyAllModules(): ModuleCheck[] {
  return Object.keys(REQUIRED_ARTIFACTS).map(verifyModule);
}

/** Write the current hashes to models/manifest.json (deploy-time step). */
export function recordManifest(): void {
  const out: Record<string, Record<string, string>> = {};
  for (const [module, files] of Object.entries(REQUIRED_ARTIFACTS)) {
    const dir = path.join(MODELS_BASE, module);
    for (const rel of files) {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) continue;
      (out[module] ??= {})[rel] = sha256File(full);
    }
  }
  fs.mkdirSync(MODELS_BASE, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(out, null, 2));
  console.log(`✅ Wrote ${MANIFEST_PATH}`);
  for (const [m, files] of Object.entries(out)) {
    for (const [f, h] of Object.entries(files)) console.log(`   ${m}/${f}  ${h.slice(0, 16)}…`);
  }
}

/** Boot-time report. Never fatal — a missing model must not stop the VMS. */
export function logModelStatus(): void {
  for (const check of verifyAllModules()) {
    if (check.ok) {
      const verified = check.artifacts.every((a) => a.matches === true);
      console.log(
        `🧩 model "${check.module}": ok${verified ? " (checksums verified)" : " (unverified — no manifest entry)"}`
      );
    } else {
      console.warn(`⚠ model "${check.module}": ${check.reason}`);
      for (const a of check.artifacts) {
        if (!a.present) console.warn(`     missing: ${a.file}`);
        else if (a.matches === false) {
          console.warn(`     CHECKSUM MISMATCH: ${a.file}\n       got      ${a.sha256}\n       expected ${a.expected}`);
        }
      }
    }
  }
}

// CLI: npx tsx server/modelRegistry.ts --record
if (process.argv[1] && process.argv[1].endsWith("modelRegistry.ts")) {
  if (process.argv.includes("--record")) recordManifest();
  else console.log(JSON.stringify(verifyAllModules(), null, 2));
}

export interface ModelReport { modules: ModuleCheck[]; checkedAt: string; }
let modelReport: ModelReport | undefined;
let modelPending: Promise<ModelReport> | undefined;
const MODEL_REPORT_TTL = 5 * 60_000;

/** Stream weights in bounded chunks. Never read entire model files on an HTTP request. */
async function inspectModels(): Promise<ModelReport> {
  let manifest: Record<string, Record<string, string>> = {};
  try { manifest = JSON.parse(await fs.promises.readFile(MANIFEST_PATH, 'utf8')); } catch { /* surfaced as unverified */ }
  const modules: ModuleCheck[] = [];
  for (const [module, files] of Object.entries(REQUIRED_ARTIFACTS)) {
    const artifacts: ArtifactCheck[] = [];
    for (const file of files) {
      const full = path.join(MODELS_BASE, module, file);
      try {
        const stat = await fs.promises.stat(full);
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
        const sha256 = hash.digest('hex');
        const after = await fs.promises.stat(full);
        const expected = manifest[module]?.[file];
        artifacts.push({ file, present: true, sizeBytes: stat.size, sha256, expected,
          matches: stat.mtimeMs !== after.mtimeMs || stat.size !== after.size ? false : expected ? expected === sha256 : undefined });
      } catch { artifacts.push({ file, present: false }); }
    }
    const missing = artifacts.filter(a => !a.present).length;
    const mismatch = artifacts.filter(a => a.matches === false).length;
    modules.push({ module, artifacts, ok: !missing && !mismatch, reason: missing ? `${missing} file(s) missing or unreadable` : mismatch ? `${mismatch} checksum(s) failed` : undefined });
  }
  return { modules, checkedAt: new Date().toISOString() };
}
export function getModelReport(): Promise<ModelReport> {
  if (modelReport && Date.now() - Date.parse(modelReport.checkedAt) < MODEL_REPORT_TTL) return Promise.resolve(modelReport);
  if (!modelPending) modelPending = inspectModels().then(value => (modelReport = value)).finally(() => { modelPending = undefined; });
  return modelPending;
}
/** Fast, stale-while-refreshing status with an explicit observation time. */
export function modelSnapshot() {
  void getModelReport().catch(err => console.error('Model verification failed:', err));
  return { modules: modelReport?.modules ?? [], checkedAt: modelReport?.checkedAt ?? null, checking: !!modelPending };
}
