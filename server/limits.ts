// server/limits.ts
//
// What a client is entitled to USE, as opposed to which features they may run.
//
//   Licence  -> WHICH capabilities (intrusion, face, PPE …)   — entitlements.ts
//   Limit    -> HOW MUCH of the platform they may consume     — this file
//
// Those are genuinely different questions and were being answered in different
// places, inconsistently: the camera cap was enforced inline in a route, the
// user cap was stored in the licence and never read by anything, and site and
// storage caps did not exist at all. A client could be sold "25 users, 5 TB"
// and exceed both without the platform noticing.
//
// WHY STORAGE IS NOT LIKE THE OTHERS
//   Refusing to create a 26th user is harmless — nothing is lost. Refusing to
//   write a recording segment loses footage that will never exist again, and on
//   a site with four buildings and a hundred cameras each, storage is the limit
//   that is actually reached. So storage WARNS on the way up and only acts at
//   the very end; the countable limits stop cleanly at the boundary.

import { sql, eq, and } from "drizzle-orm";
import { db, storage } from "./storage";
import { recordings, locations, users, cameras, organizations, licenses, products } from "@shared/schema";

/** Fraction of a limit at which the client should be told, before it bites. */
export const WARN_AT = Number(process.env.LIMIT_WARN_FRACTION || 0.8);
export const CRITICAL_AT = Number(process.env.LIMIT_CRITICAL_FRACTION || 0.95);

export type LimitKey = "maxCameras" | "maxUsers" | "maxSites" | "maxStorageGb";

export interface LimitUsage {
  key: LimitKey;
  label: string;
  /** What they are using now. Bytes are reported in GB for maxStorageGb. */
  used: number;
  /** null = no limit set for this client. */
  limit: number | null;
  unit: string;
  /** 0-1, or null when there is no limit. */
  fraction: number | null;
  level: "ok" | "warning" | "critical" | "exceeded" | "unlimited";
}

const LABELS: Record<LimitKey, { label: string; unit: string }> = {
  maxCameras: { label: "Cameras", unit: "cameras" },
  maxUsers: { label: "Users", unit: "users" },
  maxSites: { label: "Sites", unit: "sites" },
  maxStorageGb: { label: "Recording storage", unit: "GB" },
};

function levelFor(used: number, limit: number | null): LimitUsage["level"] {
  if (limit === null) return "unlimited";
  if (limit <= 0) return "unlimited";
  const f = used / limit;
  if (f >= 1) return "exceeded";
  if (f >= CRITICAL_AT) return "critical";
  if (f >= WARN_AT) return "warning";
  return "ok";
}

/**
 * The caps for one organisation, from its base `vms` licence.
 *
 * Limits ride on the base licence rather than on each analytics licence: a
 * client has one camera allowance, not one per feature they bought.
 */
export async function limitsFor(organizationId: string): Promise<Partial<Record<LimitKey, number>>> {
  const licence = await storage.getEffectiveLicense(organizationId, "vms");
  const raw = (licence?.limits ?? {}) as Record<string, unknown>;
  const out: Partial<Record<LimitKey, number>> = {};
  for (const k of Object.keys(LABELS) as LimitKey[]) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Bytes of recordings currently held for one organisation. */
export async function storageBytesFor(organizationId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${recordings.fileSize}), 0)` })
    .from(recordings)
    .where(eq(recordings.organizationId, organizationId));
  return Number(rows[0]?.total ?? 0);
}

async function countRows(table: any, organizationId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(table)
    .where(eq(table.organizationId, organizationId));
  return Number(rows[0]?.n ?? 0);
}

/** Current consumption for one organisation, against its caps. */
export async function usageFor(organizationId: string): Promise<LimitUsage[]> {
  const limits = await limitsFor(organizationId);
  const [cameraCount, userCount, siteCount, bytes] = await Promise.all([
    storage.countCamerasByOrg(organizationId),
    countRows(users, organizationId),
    db.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.organizationId, organizationId), eq(locations.kind, "site"))).then(rows => rows[0].n),
    storageBytesFor(organizationId),
  ]);

  const used: Record<LimitKey, number> = {
    maxCameras: cameraCount,
    maxUsers: userCount,
    maxSites: siteCount,
    // Reported in GB so the number a client sees matches the number sold.
    maxStorageGb: Math.round((bytes / 1024 ** 3) * 100) / 100,
  };

  return (Object.keys(LABELS) as LimitKey[]).map((key) => {
    const limit = limits[key] ?? null;
    return {
      key,
      label: LABELS[key].label,
      unit: LABELS[key].unit,
      used: used[key],
      limit,
      fraction: limit ? used[key] / limit : null,
      level: levelFor(used[key], limit),
    };
  });
}

export interface LimitCheck {
  ok: boolean;
  /** A sentence for the client, naming the cap and who can raise it. */
  message?: string;
  usage?: LimitUsage;
}

/**
 * May this organisation add one more of something?
 *
 * Called at the point of creation. The message names the actual number and
 * says who can change it — "limit reached" alone leaves a client admin with
 * nowhere to go.
 */
export async function canAdd(
  organizationId: string,
  key: Exclude<LimitKey, "maxStorageGb">
): Promise<LimitCheck> {
  const all = await usageFor(organizationId);
  const usage = all.find((u) => u.key === key)!;
  if (usage.limit === null) return { ok: true, usage };
  if (usage.used >= usage.limit) {
    return {
      ok: false,
      usage,
      message:
        `${usage.label} limit reached — your plan allows ${usage.limit} ` +
        `${usage.unit} and you have ${usage.used}. Contact your provider to raise it.`,
    };
  }
  return { ok: true, usage };
}

/**
 * Storage is checked but NEVER used to refuse a recording.
 *
 * Footage that is not written does not exist later, so the honest response to a
 * full quota is to tell somebody loudly and keep recording — not to create a
 * silent gap in a security system's history. The platform's own disk monitor
 * (storageMonitor.ts) is the backstop that protects the host itself.
 */
export async function storagePressure(organizationId: string): Promise<LimitUsage> {
  const all = await usageFor(organizationId);
  return all.find((u) => u.key === "maxStorageGb")!;
}

/** Every organisation's usage, for the platform overview. */
/** Aggregate each resource independently: no join multiplication and no per-client queries. */
export async function usageForAllOrgs() {
  // Camera health comes from the LIVE recorder processes, never from the
  // `cameras.status` column. That column is set when a camera is created and
  // never updated, so reading it as connectivity reported every configured
  // camera as online — a security console that goes green precisely when the
  // site has gone dark. A camera this process does not supervise is "unknown",
  // which is the honest answer, not "offline".
  const [running, ownership] = await Promise.all([
    Promise.resolve(recorderRunningByCamera()),
    db.execute(sql`SELECT id, organization_id FROM ${cameras}`),
  ]);
  const healthByOrg = new Map<string, { online: number; offline: number; unknown: number }>();
  for (const row of ownership.rows as any[]) {
    const orgId = row.organization_id as string | null;
    if (!orgId) continue;
    const h = healthByOrg.get(orgId) ?? { online: 0, offline: 0, unknown: 0 };
    const state = running.get(row.id as string);
    if (state === true) h.online++;
    else if (state === false) h.offline++;
    else h.unknown++;
    healthByOrg.set(orgId, h);
  }

  const result = await db.execute(sql`
    WITH camera_counts AS (
      SELECT organization_id, count(*)::int AS total
      FROM ${cameras} GROUP BY organization_id
    ), user_counts AS (SELECT organization_id, count(*)::int AS total FROM ${users} GROUP BY organization_id),
    site_counts AS (SELECT organization_id, count(*)::int AS total FROM ${locations} WHERE kind = 'site' GROUP BY organization_id),
    recording_sizes AS (SELECT organization_id, coalesce(sum(file_size), 0) AS bytes FROM ${recordings} GROUP BY organization_id),
    base_limits AS (
      SELECT l.organization_id, l.limits, l.plan, l.expires_at
      FROM ${licenses} l JOIN ${products} p ON p.id = l.product_id WHERE p.key = 'vms'
    ),
    org_admins AS (
      SELECT DISTINCT ON (organization_id) organization_id, username, email
      FROM ${users}
      WHERE role = 'client_admin'
      ORDER BY organization_id, created_at ASC, id ASC
    )
    SELECT o.id, o.name, o.slug, o.status, o.created_at, l.limits, l.plan, l.expires_at,
      a.username AS administrator_name, a.email AS administrator_email,
      coalesce(c.total, 0) AS cameras,
      coalesce(u.total, 0) AS users, coalesce(s.total, 0) AS sites, coalesce(r.bytes, 0) AS bytes
    FROM ${organizations} o LEFT JOIN camera_counts c ON c.organization_id = o.id
    LEFT JOIN user_counts u ON u.organization_id = o.id LEFT JOIN site_counts s ON s.organization_id = o.id
    LEFT JOIN recording_sizes r ON r.organization_id = o.id LEFT JOIN base_limits l ON l.organization_id = o.id
    LEFT JOIN org_admins a ON a.organization_id = o.id
    ORDER BY o.name, o.id
  `);
  return result.rows.map((row: any) => {
    const used = { maxCameras: Number(row.cameras), maxUsers: Number(row.users), maxSites: Number(row.sites), maxStorageGb: Math.round(Number(row.bytes) / 1024 ** 3 * 100) / 100 };
    return {
      organizationId: row.id as string, name: row.name as string, slug: row.slug as string,
      status: row.status as string, createdAt: row.created_at,
      administratorName: row.administrator_name as string | null,
      administratorEmail: row.administrator_email as string | null,
      plan: row.plan as string | null,
      expiresAt: row.expires_at as string | null,
      health: healthByOrg.get(row.id as string) ?? { online: 0, offline: 0, unknown: Number(row.cameras) },
      usage: (Object.keys(LABELS) as LimitKey[]).map(key => {
        const raw = Number(row.limits?.[key]);
        const limit = Number.isFinite(raw) && raw > 0 ? raw : null;
        return { key, ...LABELS[key], used: used[key], limit, fraction: limit ? used[key] / limit : null, level: levelFor(used[key], limit) };
      }),
    };
  });
}

/* ---------------------------------------------------------------- watcher --
 *
 * Tell a client they are running out of the storage they bought, BEFORE it
 * matters — and keep telling nobody twice about the same thing.
 *
 * The platform already watches the host's disk (storageMonitor.ts). That
 * protects the server; it says nothing about whether one client has used the
 * 5 TB they were sold while another sits at 2% of theirs. On a shared box the
 * disk monitor stays green until every client is about to lose recording at
 * once, and it cannot say whose fault it is.
 */

import { emitEvent } from "./events";
import { recorderRunningByCamera } from "./recordingWorker";

const QUOTA_CHECK_MS = Number(process.env.QUOTA_CHECK_INTERVAL_MS || 15 * 60_000);

/** Last level announced per org+limit, so a steady state stays quiet. */
const announced = new Map<string, LimitUsage["level"]>();
let timer: NodeJS.Timeout | null = null;

export async function checkQuotas(): Promise<void> {
  let all;
  try {
    all = await usageForAllOrgs();
  } catch (err) {
    console.error("❌ quota check failed:", err);
    return;
  }

  for (const org of all) {
    for (const u of org.usage) {
      if (u.limit === null) continue;
      const key = `${org.organizationId}:${u.key}`;
      const previous = announced.get(key);
      // Only a CHANGE of level is news. Re-announcing "still at 86%" every
      // fifteen minutes is how a client learns to ignore the alert that
      // matters.
      if (previous === u.level) continue;
      announced.set(key, u.level);

      if (u.level === "ok" || u.level === "unlimited") continue;

      const pct = Math.round((u.fraction ?? 0) * 100);
      const detail =
        u.key === "maxStorageGb"
          ? `${u.used} GB of ${u.limit} GB`
          : `${u.used} of ${u.limit} ${u.unit}`;

      if (u.level === "exceeded") {
        emitEvent(
          "quota_exceeded",
          `${org.name} has used all of its ${u.label.toLowerCase()} allowance ` +
            `(${detail}). ` +
            (u.key === "maxStorageGb"
              ? "Recording continues — footage is never dropped to stay inside a " +
                "quota — but the allowance needs raising or older recordings removing."
              : "No more can be added until the allowance is raised."),
          undefined,
          org.organizationId
        );
      } else {
        emitEvent(
          u.level === "critical" ? "quota_critical" : "quota_warning",
          `${org.name} is at ${pct}% of its ${u.label.toLowerCase()} allowance (${detail}).`,
          undefined,
          org.organizationId
        );
      }
    }
  }
}

export function startQuotaMonitor(): void {
  void checkQuotas();
  timer = setInterval(() => void checkQuotas(), QUOTA_CHECK_MS);
  console.log(
    `📊 quota monitor: warn at ${Math.round(WARN_AT * 100)}%, ` +
      `critical at ${Math.round(CRITICAL_AT * 100)}%, every ${QUOTA_CHECK_MS / 60000} min`
  );
}

export function stopQuotaMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam — forget what has been announced. */
export function resetQuotaStateForTest(): void {
  announced.clear();
}
