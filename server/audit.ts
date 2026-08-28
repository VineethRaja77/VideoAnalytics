// server/audit.ts
//
// Append-only audit trail: who did what, to what, when, from where.
//
// Two rules govern everything here.
//
// 1. AUDITING MUST NEVER BREAK THE ACTION IT RECORDS. A failed insert is logged
//    loudly and swallowed. A client losing the ability to view a camera because
//    the audit table is full would be a self-inflicted outage, and the same
//    disk-pressure incident that fills the table would then take down the VMS.
//
// 2. NO SECRETS EVER REACH THIS TABLE. The audit trail is the most widely-read
//    table in the product — client admins, auditors, support — so a leaked
//    password or stream credential here is worse than anywhere else. `detail`
//    is scrubbed on the way in rather than trusting every call site.

import type { Request } from "express";
import { db } from "./storage";
import { auditLog, type AuditAction } from "@shared/schema";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

/**
 * Keys whose VALUES are never stored, at any nesting depth. Matching is on a
 * normalised key name, so `streamUrl`, `stream_url` and `STREAMURL` all hit.
 * The key itself is kept with a "[redacted]" marker: knowing that the password
 * changed is the audit fact; knowing what it changed to is the leak.
 */
const SECRET_KEYS = [
  "password", "passwordhash", "pass", "secret", "token", "apikey", "key",
  "streamurl", "rtspurl", "url", "ingestkey", "authorization", "cookie",
  "sessionsecret", "encryptionkey", "credential", "embedding",
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\-\s]/g, "");
  return SECRET_KEYS.some((s) => k === s || k.endsWith(s) || k.startsWith(s));
}

/** Recursively strip secret values. Depth-capped so a cyclic or absurdly deep
 *  object cannot hang the request thread. */
export function scrubDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDetail(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[redacted]" : scrubDetail(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return value.slice(0, 500) + "…";
  return value;
}

/**
 * Client IP.
 *
 * Deliberately just `req.ip`: Express derives it from X-Forwarded-For according
 * to the app's `trust proxy` setting (index.ts sets 1, meaning one reverse
 * proxy — nginx — is trusted). Parsing the header manually here would IGNORE
 * that setting and take whatever the caller sent, letting anyone write a false
 * origin into the audit trail. The framework's rule is the correct one; the
 * only thing that must be right is `trust proxy` matching the real topology.
 */
function clientIp(req: Request): string | null {
  return (req.ip || req.socket?.remoteAddress || null)?.slice(0, 64) ?? null;
}

export interface AuditInput {
  action: AuditAction;
  /** Org the action AFFECTED — not necessarily the actor's own org. */
  organizationId?: string | null;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string | null;
  outcome?: "success" | "denied" | "error";
  detail?: unknown;
  /** Override the actor, for events with no session (a failed login). */
  actor?: { id?: string | null; username?: string | null; role?: string | null };
}

/**
 * Record one auditable action.
 *
 * Fire-and-forget by design: callers `void audit(req, {...})` after the action
 * has succeeded. Returns a promise only so tests can await the write.
 */
export async function audit(req: Request, input: AuditInput): Promise<void> {
  const user = (req as Request & { user?: any }).user;
  const actorId = input.actor?.id ?? user?.id ?? null;
  const actorUsername = input.actor?.username ?? user?.username ?? null;
  const actorRole = input.actor?.role ?? user?.role ?? null;

  try {
    await db.insert(auditLog).values({
      organizationId: input.organizationId ?? user?.organizationId ?? null,
      actorId,
      actorUsername,
      actorRole,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ? String(input.targetLabel).slice(0, 300) : null,
      outcome: input.outcome ?? "success",
      detail: (input.detail === undefined ? null : scrubDetail(input.detail)) as any,
      ipAddress: clientIp(req),
      userAgent: req.header("user-agent")?.slice(0, 300) ?? null,
    });
  } catch (err) {
    // Loud, specific, and non-fatal. If this ever fires in production it means
    // the compliance trail has a hole, so the message says exactly that rather
    // than "db error".
    console.error(
      `❌ AUDIT WRITE FAILED — action="${input.action}" actor="${actorUsername ?? "anonymous"}" ` +
        `target=${input.targetType ?? "-"}:${input.targetId ?? "-"}. ` +
        `The action itself SUCCEEDED but is not recorded in the audit trail:`,
      err
    );
  }
}

export interface AuditQuery {
  organizationId: string | null;
  isSuperAdmin?: boolean;
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Read the trail, org-scoped.
 *
 * A caller with no resolvable org gets NOTHING, never the global trail — the
 * same fail-closed rule as notifications. Only super_admin sees across tenants.
 */
export async function listAudit(q: AuditQuery) {
  const where = [];
  if (!q.isSuperAdmin) {
    if (!q.organizationId) return [];
    where.push(eq(auditLog.organizationId, q.organizationId));
  } else if (q.organizationId) {
    where.push(eq(auditLog.organizationId, q.organizationId));
  }
  if (q.action) where.push(eq(auditLog.action, q.action));
  if (q.actorId) where.push(eq(auditLog.actorId, q.actorId));
  if (q.from) where.push(gte(auditLog.createdAt, q.from));
  if (q.to) where.push(lte(auditLog.createdAt, q.to));

  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);

  return db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : sql`true`)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/**
 * Delete audit rows older than AUDIT_RETENTION_DAYS.
 *
 * Deliberately NOT enabled by default (0 = keep forever): silently discarding a
 * compliance trail is a worse failure than using disk. An operator who sets it
 * has made an explicit retention decision. Minimum floor of 365 days when set,
 * because a shorter window would not survive most audits.
 */
export async function purgeExpiredAudit(): Promise<number> {
  const days = Number(process.env.AUDIT_RETENTION_DAYS || 0);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const effective = Math.max(days, 365);
  if (effective !== days) {
    console.warn(
      `⚠ AUDIT_RETENTION_DAYS=${days} is below the 365-day floor; using 365. ` +
        `Audit history is a compliance record, not a cache.`
    );
  }
  const cutoff = new Date(Date.now() - effective * 24 * 60 * 60 * 1000);
  const removed = await db.delete(auditLog).where(lte(auditLog.createdAt, cutoff)).returning({ id: auditLog.id });
  if (removed.length) console.log(`🧹 Purged ${removed.length} audit row(s) older than ${effective} days`);
  return removed.length;
}
