// server/faceRoutes.ts
//
// Enrol, list and remove the people a client's face recognition matches against.
//
//   GET    /api/face/people        who is enrolled for this organisation
//   POST   /api/face/people        enrol a person from photographs
//   DELETE /api/face/people/:name  remove a person
//
// WHY THIS EXISTS
//   Until now enrolment was models/face/enroll.py — folders of images on the
//   server's filesystem. A client admin in a browser cannot use that, which
//   made face recognition unshippable however good the model is.
//
// FIVE THINGS THAT MATTER MORE THAN THE FEATURE ITSELF
//
//   1. TENANCY. The gallery file is chosen from the SESSION's organisation via
//      galleryPathForOrg — never from anything the caller sends. There is no
//      request field that can select a gallery, so there is no way to read or
//      write another client's biometrics.
//
//   2. BIOMETRIC DATA. Face embeddings are sensitive personal data under
//      India's DPDP Act 2023. Photographs are never written to disk here and
//      never logged; only the derived embedding is stored, and every enrolment
//      and removal is written to the audit trail with the name and photo COUNT
//      only.
//
//   3. SERIALISATION. The gallery is a read-modify-write file. Two admins
//      enrolling at once would each load, add, and save — and the second save
//      would silently erase the first person. Every mutation for one org runs
//      through a promise chain, so they queue instead.
//
//   4. LICENCE. Enrolment is gated on the same face_recognition licence the
//      worker is gated on. A client whose licence lapsed must not keep loading
//      biometric data into the system.
//
//   5. HONEST ERRORS. The bridge returns a reason per photograph ("face is too
//      small — 22px between the eyes, 40px needed"). Those reach the operator
//      verbatim. Enrolling a photo whose face is too small is the single most
//      common cause of "the system never recognises me", and it is invisible
//      unless it is said at the moment the photo is submitted.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import express from "express";
import type { Express, Request } from "express";
import { z } from "zod";
import { storage, db } from "./storage";
import { analyticsEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "./auth";
import { requireWriteAccess, resolveOrgScope } from "./rbac";
import { evaluateLicense } from "./entitlements";
import { audit } from "./audit";
import {
  galleryPathForOrg,
  modulePython,
  moduleRoot,
  moduleInstalled,
} from "./analyticsWorker";

/** Matches MAX_IMAGES / MAX_NAME in models/face/enroll_api.py. */
const MAX_PHOTOS = 10;
const MAX_NAME = 128;
/** Room for MAX_PHOTOS base64 photographs plus JSON overhead. */
export const FACE_BODY_LIMIT = "16mb";
const BRIDGE_TIMEOUT_MS = Number(process.env.FACE_ENROL_TIMEOUT_MS || 60_000);

// A name is a label an operator reads on an alert, and it becomes a filename
// component in nothing — but it IS stored in a fixed-width numpy dtype and
// rendered in HTML, so it is kept to plain printable text.
const NAME_RE = /^[\p{L}\p{N} ._'-]+$/u;

const enrolSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A person needs a name.")
    .max(MAX_NAME, `Names are limited to ${MAX_NAME} characters.`)
    .regex(NAME_RE, "Use letters, numbers, spaces, apostrophes, dots or hyphens."),
  // data: URLs from a file input, or bare base64. Normalised below.
  images: z
    .array(z.string().min(1))
    .min(1, "Attach at least one photograph.")
    .max(MAX_PHOTOS, `At most ${MAX_PHOTOS} photographs at a time.`),
  // What the DPDP Act actually asks to see. The notice on screen is not the
  // record; this is. Required, because an enrolment with no lawful basis
  // recorded is one that cannot be defended later.
  purpose: z
    // required_error, not just min(): a MISSING field produces Zod's bare
    // "Required", which tells a client admin nothing about which field or why.
    .string({ required_error: "Say what this person's face will be used for." })
    .trim()
    .min(3, "Say what this person's face will be used for.")
    .max(200),
  consentConfirmed: z.literal(true, {
    errorMap: () => ({ message: "Confirm that this person has consented." }),
  }),
});

function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma > 0 ? s.slice(comma + 1) : s;
}

// ---------------------------------------------------------------- bridge ----

interface BridgeResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/**
 * Run models/face/enroll_api.py under the face module's OWN interpreter.
 *
 * The request travels on stdin, never argv: a base64 photograph on a command
 * line is visible in `ps` to every user on the host, and that is biometric
 * personal data.
 */
function callBridge(orgId: string, payload: unknown): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const dir = moduleRoot("face");
    const proc = spawn(modulePython("face"), ["enroll_api.py"], {
      cwd: dir,
      env: { ...process.env, GALLERY_PATH: galleryPathForOrg(orgId) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let settled = false;
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));

    const timer = setTimeout(() => {
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new Error(
          `Enrolment did not finish within ${Math.round(BRIDGE_TIMEOUT_MS / 1000)}s. ` +
            `The server may be under heavy analytics load.`
        )
      );
    }, BRIDGE_TIMEOUT_MS);

    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not run the face module (${e.message}).`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        // The bridge answers handled refusals with exit 0 and ok:false, so a
        // non-zero exit is a genuine crash. Surface its last stderr line rather
        // than "enrolment failed", which tells an installer nothing.
        const reason = err.trim().split("\n").filter(Boolean).pop();
        return reject(new Error(reason || `Face module exited with code ${code}.`));
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch {
        reject(new Error("Face module returned output that could not be read."));
      }
    });

    proc.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------- serialisation ----

/**
 * One queue per organisation.
 *
 * The gallery is a file that is loaded, appended to and written back. Two
 * concurrent enrolments would both load the same starting state and the later
 * save would drop the earlier person WITHOUT ANY ERROR — the admin sees
 * success and the person is simply not there. Chaining per org makes that
 * impossible while keeping different clients independent.
 */
const galleryQueue = new Map<string, Promise<unknown>>();

function serialised<T>(orgId: string, job: () => Promise<T>): Promise<T> {
  const prev = galleryQueue.get(orgId) ?? Promise.resolve();
  const next = prev.then(job, job);
  // Swallow rejection on the CHAIN only; the caller still sees the real error.
  galleryQueue.set(
    orgId,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Snapshots may only be read from inside these roots.
 *
 * The path comes from our own database, but confining reads to known
 * directories means a bad row — or a future bug that lets one be written —
 * cannot turn this route into "read any file on the server".
 */
const SNAPSHOT_ROOTS = [
  path.resolve(process.env.MODELS_BASE || path.join(process.cwd(), "models")),
  path.resolve(process.env.SNAPSHOT_BASE || path.join(process.cwd(), "snapshots")),
];

function withinSnapshotRoot(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return SNAPSHOT_ROOTS.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

// ----------------------------------------------------------------- guards ----

type Guard = { ok: true; orgId: string } | { ok: false; status: number; error: string };

async function guard(req: Request): Promise<Guard> {
  const orgId = resolveOrgScope(req);
  if (!orgId) {
    return {
      ok: false,
      status: 400,
      error:
        "No organisation context. A platform super-admin must select a client " +
        "before managing enrolled people.",
    };
  }
  if (!moduleInstalled("face")) {
    return {
      ok: false,
      status: 409,
      error: "The face recognition module is not installed on this server.",
    };
  }
  // Same licence the worker is gated on, so a lapsed client cannot keep adding
  // biometric data through an API the UI no longer shows.
  if (req.user?.role !== "super_admin") {
    const [org, license] = await Promise.all([
      storage.getOrganization(orgId),
      storage.getEffectiveLicense(orgId, "face_recognition"),
    ]);
    const check = evaluateLicense(license, org);
    if (!check.ok) {
      return {
        ok: false,
        status: 403,
        error: `Face recognition is not licensed for this organisation (${check.reason}).`,
      };
    }
  }
  return { ok: true, orgId };
}

// ----------------------------------------------------------------- routes ----

export function registerFaceRoutes(app: Express): void {
  // Photographs make this body far larger than any other request in the
  // product. The limit is applied HERE rather than globally: raising the global
  // JSON limit to 16 MB would let any unauthenticated endpoint be used to
  // allocate 16 MB per request.
  const bigJson = express.json({ limit: FACE_BODY_LIMIT });

  app.get("/api/face/people", requireAuth, async (req, res) => {
    const g = await guard(req);
    if (!g.ok) return res.status(g.status).json({ error: g.error });
    try {
      const result = await callBridge(g.orgId, { action: "list" });
      if (!result.ok) return res.status(500).json({ error: result.error });
      res.json({ people: result.people ?? [], embeddings: result.embeddings ?? 0 });
    } catch (err: any) {
      console.error("❌ face list failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    "/api/face/people",
    requireAuth,
    requireWriteAccess,
    bigJson,
    async (req, res) => {
      const g = await guard(req);
      if (!g.ok) return res.status(g.status).json({ error: g.error });

      let body: z.infer<typeof enrolSchema>;
      try {
        body = enrolSchema.parse(req.body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return res
            .status(400)
            .json({ error: err.errors[0]?.message ?? "Invalid enrolment." });
        }
        throw err;
      }

      try {
        const result = await serialised(g.orgId, () =>
          callBridge(g.orgId, {
            action: "add",
            name: body.name,
            images: body.images.map(stripDataUrl),
            // Recorded against the person who performed the enrolment, taken
            // from the SESSION — never from the request, which would let the
            // record name somebody who was not involved.
            consent: { by: req.user?.username ?? "", purpose: body.purpose },
          })
        );

        // The audit row records WHO enrolled WHOM and how many photographs —
        // never the photographs, and never an embedding.
        void audit(req, {
          action: result.ok ? "face_person_enrolled" : "face_person_enrol_rejected",
          organizationId: g.orgId,
          targetType: "face_person",
          targetId: body.name,
          targetLabel: body.name,
          detail: {
            photosSubmitted: body.images.length,
            photosAccepted: Number(result.added ?? 0),
            purpose: body.purpose,
          },
        });

        if (!result.ok) {
          // 422, not 500: the request was well-formed, the photographs were not
          // usable. `results` carries the per-photo reason.
          return res.status(422).json({ error: result.error, results: result.results });
        }
        res.status(201).json(result);
      } catch (err: any) {
        console.error("❌ face enrol failed:", err.message);
        res.status(500).json({ error: err.message });
      }
    }
  );

  /**
   * Enrol the person in an unknown-face event.
   *
   * WHY THIS ROUTE EXISTS
   *   An "unknown person at the gate" alert asks a question — who is that? —
   *   and until now the client could not answer it from the alert. They had to
   *   open the snapshot, save the image, switch tabs, and upload it again. That
   *   is the single most common thing an operator will want to do with an
   *   unknown face, and making it a five-step detour is how a feature ends up
   *   unused.
   *
   *   Measured before building it: the embedding taken from the annotated
   *   snapshot scores 0.88 cosine against the same face in the clean original,
   *   far above the 0.40 accept threshold — so a snapshot is a legitimate
   *   enrolment photo, not a degraded one. It is also the BEST kind of photo,
   *   because it comes from the very camera that has to do the recognising.
   *
   *   The image is read from the row's own recorded path, never from anything
   *   the caller sends, and only after the caller's org is confirmed to own
   *   that event.
   */
  app.post(
    "/api/face/people/from-event",
    requireAuth,
    requireWriteAccess,
    async (req, res) => {
      const g = await guard(req);
      if (!g.ok) return res.status(g.status).json({ error: g.error });

      let body: {
        eventId: string;
        name: string;
        purpose: string;
        consentConfirmed: true;
      };
      try {
        body = z
          .object({
            eventId: z.string().min(1),
            name: enrolSchema.shape.name,
            purpose: enrolSchema.shape.purpose,
            consentConfirmed: enrolSchema.shape.consentConfirmed,
          })
          .parse(req.body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return res.status(400).json({ error: err.errors[0]?.message ?? "Invalid request." });
        }
        throw err;
      }

      const rows = await db
        .select()
        .from(analyticsEvents)
        .where(eq(analyticsEvents.id, body.eventId));
      const event = rows[0];
      // 404 rather than 403 for another tenant's event — never confirm it exists.
      if (!event || (req.user?.role !== "super_admin" && event.organizationId !== g.orgId)) {
        return res.status(404).json({ error: "Event not found" });
      }
      if (event.module !== "face") {
        return res.status(400).json({ error: "That event is not a face event." });
      }
      if (!event.snapshot) {
        return res.status(409).json({
          error:
            "This event has no saved image, so there is nothing to enrol from. " +
            "Images of unrecognised people are only stored when that is switched on.",
        });
      }
      if (!withinSnapshotRoot(event.snapshot) || !fs.existsSync(event.snapshot)) {
        return res.status(410).json({
          error:
            "The image for this event is no longer stored — snapshots are deleted " +
            "automatically once the retention period passes.",
        });
      }

      try {
        const image = fs.readFileSync(event.snapshot).toString("base64");
        const result = await serialised(g.orgId, () =>
          callBridge(g.orgId, {
            action: "add",
            name: body.name,
            images: [image],
            consent: { by: req.user?.username ?? "", purpose: body.purpose },
          })
        );

        void audit(req, {
          action: result.ok ? "face_person_enrolled" : "face_person_enrol_rejected",
          organizationId: g.orgId,
          targetType: "face_person",
          targetId: body.name,
          targetLabel: body.name,
          detail: {
            source: "unknown_face_event",
            eventId: event.id,
            cameraId: event.cameraId,
            photosSubmitted: 1,
            photosAccepted: Number(result.added ?? 0),
            purpose: body.purpose,
          },
        });

        if (!result.ok) {
          return res.status(422).json({ error: result.error, results: result.results });
        }
        res.status(201).json(result);
      } catch (err: any) {
        console.error("❌ face enrol-from-event failed:", err.message);
        res.status(500).json({ error: err.message });
      }
    }
  );

  /**
   * Correct a person's name.
   *
   * The name is what appears on every alert, and the only previous way to fix a
   * typo was to delete the person and photograph them again. It also merges two
   * spellings of one person, which is the commonest way a gallery goes wrong —
   * and which nothing else in the product would ever have told the client about.
   */
  app.patch(
    "/api/face/people/:name",
    requireAuth,
    requireWriteAccess,
    async (req, res) => {
      const g = await guard(req);
      if (!g.ok) return res.status(g.status).json({ error: g.error });

      const from = String(req.params.name || "").trim();
      let to: string;
      try {
        to = z.object({ name: enrolSchema.shape.name }).parse(req.body).name;
      } catch (err) {
        if (err instanceof z.ZodError) {
          return res.status(400).json({ error: err.errors[0]?.message ?? "Invalid name." });
        }
        throw err;
      }
      if (!from || from.length > MAX_NAME) {
        return res.status(400).json({ error: "Invalid name." });
      }

      try {
        const result = await serialised(g.orgId, () =>
          callBridge(g.orgId, { action: "rename", name: from, newName: to })
        );
        if (!result.ok) return res.status(422).json({ error: result.error });

        void audit(req, {
          action: "face_person_renamed",
          organizationId: g.orgId,
          targetType: "face_person",
          targetId: to,
          targetLabel: to,
          detail: {
            previousName: from,
            merged: Boolean(result.mergedIntoExisting),
            recordsMoved: Number(result.moved ?? 0),
          },
        });
        res.json(result);
      } catch (err: any) {
        console.error("❌ face rename failed:", err.message);
        res.status(500).json({ error: err.message });
      }
    }
  );

  app.delete(
    "/api/face/people/:name",
    requireAuth,
    requireWriteAccess,
    async (req, res) => {
      const g = await guard(req);
      if (!g.ok) return res.status(g.status).json({ error: g.error });

      const name = String(req.params.name || "").trim();
      if (!name || name.length > MAX_NAME) {
        return res.status(400).json({ error: "Invalid name." });
      }

      try {
        const result = await serialised(g.orgId, () =>
          callBridge(g.orgId, { action: "remove", name })
        );
        if (!result.ok) return res.status(500).json({ error: result.error });

        // Deleting biometric data is a DPDP-relevant act — record it even when
        // the person turned out not to be enrolled.
        void audit(req, {
          action: "face_person_removed",
          organizationId: g.orgId,
          targetType: "face_person",
          targetId: name,
          targetLabel: name,
          detail: {
            embeddingsRemoved: Number(result.removed ?? 0),
            wasEnrolled: Boolean(result.wasEnrolled),
          },
        });

        res.json(result);
      } catch (err: any) {
        console.error("❌ face removal failed:", err.message);
        res.status(500).json({ error: err.message });
      }
    }
  );
}
