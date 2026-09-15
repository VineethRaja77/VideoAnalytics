import type { Express } from "express";
import {
  and,
  desc,
  eq,
  ilike,
  or,
  sql,
  gte,
  lt,
  getTableColumns,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "./storage";
import {
  auditLog,
  users,
  organizations,
  licenses,
  products,
} from "@shared/schema";
import { usageForAllOrgs } from "./limits";
import { listEvents } from "./events";

const pageSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().max(160).default(""),
    status: z.string().max(30).default("all"),
    orgId: z.string().max(100).optional(),
    action: z.string().max(100).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(
    (q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to),
    "End date must follow start date",
  );
const pattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/** Dedicated bounded read models. Existing integration APIs retain their contracts. */
export function registerConsoleRoutes(app: Express) {
  app.get("/api/admin/console/:section", async (req, res) => {
    const started = performance.now();
    try {
      const q = pageSchema.parse(req.query);
      const offset = (q.page - 1) * q.pageSize;
      let data: unknown;
      if (
        req.params.section === "clients" ||
        req.params.section === "overview"
      ) {
        const all = await usageForAllOrgs();
        if (req.params.section === "clients") {
          const filtered = all.filter(
            (row) =>
              (q.status === "all" || row.status === q.status) &&
              `${row.name} ${row.slug}`
                .toLowerCase()
                .includes(q.search.toLowerCase()),
          );
          data = {
            rows: filtered.slice(offset, offset + q.pageSize),
            total: filtered.length,
          };
        } else {
          const [licenseStats] = await db
            .select({
              active: sql<number>`count(*) filter (where ${licenses.status} in ('active', 'trial') and (${licenses.expiresAt} is null or ${licenses.expiresAt} > now()))::int`,
              expiring: sql<number>`count(*) filter (where ${licenses.status} in ('active', 'trial') and ${licenses.expiresAt} > now() and ${licenses.expiresAt} <= now() + interval '30 days')::int`,
            })
            .from(licenses);
          const pressure = all.filter((row) =>
            row.usage.some((u) =>
              ["warning", "critical", "exceeded"].includes(u.level),
            ),
          );
          data = {
            clients: all.length,
            activeClients: all.filter((row) => row.status === "active").length,
            cameras: all.reduce((n, row) => n + row.usage[0].used, 0),
            online: all.reduce((n, row) => n + row.health.online, 0),
            offline: all.reduce((n, row) => n + row.health.offline, 0),
            unknown: all.reduce((n, row) => n + row.health.unknown, 0),
            licenseStats,
            pressureCount: pressure.length,
            pressure: pressure.slice(0, 6),
            recentClients: [...all]
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime(),
              )
              .slice(0, 5),
            checkedAt: new Date().toISOString(),
          };
        }
      } else if (req.params.section === "admins") {
        const where = and(
          eq(users.role, "client_admin"),
          q.orgId ? eq(users.organizationId, q.orgId) : undefined,
          q.status !== "all" ? eq(users.status, q.status) : undefined,
          q.search
            ? or(
                ilike(users.username, pattern(q.search)),
                ilike(users.email, pattern(q.search)),
                ilike(organizations.name, pattern(q.search)),
              )
            : undefined,
        );
        const [rows, [count]] = await Promise.all([
          db
            .select({
              id: users.id,
              username: users.username,
              email: users.email,
              status: users.status,
              role: users.role,
              organizationId: users.organizationId,
              clientName: organizations.name,
              createdAt: users.createdAt,
            })
            .from(users)
            .leftJoin(organizations, eq(users.organizationId, organizations.id))
            .where(where)
            .orderBy(desc(users.createdAt), users.id)
            .limit(q.pageSize)
            .offset(offset),
          db
            .select({ total: sql<number>`count(*)::int` })
            .from(users)
            .leftJoin(organizations, eq(users.organizationId, organizations.id))
            .where(where),
        ]);
        data = { rows, total: count.total };
      } else if (req.params.section === "licenses") {
        const effectiveStatus = sql<string>`case when ${licenses.status} in ('active','trial') and ${licenses.expiresAt} <= now() then 'expired' else ${licenses.status} end`;
        const where = and(
          q.orgId ? eq(licenses.organizationId, q.orgId) : undefined,
          q.status !== "all" ? eq(effectiveStatus, q.status) : undefined,
          q.search
            ? or(
                ilike(organizations.name, pattern(q.search)),
                ilike(products.name, pattern(q.search)),
              )
            : undefined,
        );
        const [rows, [count]] = await Promise.all([
          db
            .select({
              id: licenses.id,
              organizationId: licenses.organizationId,
              clientName: organizations.name,
              productKey: products.key,
              productName: products.name,
              plan: licenses.plan,
              status: effectiveStatus,
              storedStatus: licenses.status,
              expiresAt: licenses.expiresAt,
              machineFingerprint: licenses.machineFingerprint,
              limits: licenses.limits,
            })
            .from(licenses)
            .innerJoin(
              organizations,
              eq(organizations.id, licenses.organizationId),
            )
            .innerJoin(products, eq(products.id, licenses.productId))
            .where(where)
            .orderBy(desc(licenses.issuedAt), licenses.id)
            .limit(q.pageSize)
            .offset(offset),
          db
            .select({ total: sql<number>`count(*)::int` })
            .from(licenses)
            .innerJoin(
              organizations,
              eq(organizations.id, licenses.organizationId),
            )
            .innerJoin(products, eq(products.id, licenses.productId))
            .where(where),
        ]);
        data = { rows, total: count.total };
      } else if (req.params.section === "audit") {
        const where = and(
          q.orgId ? eq(auditLog.organizationId, q.orgId) : undefined,
          q.action ? eq(auditLog.action, q.action) : undefined,
          q.from ? gte(auditLog.createdAt, new Date(q.from)) : undefined,
          q.to ? lt(auditLog.createdAt, new Date(q.to)) : undefined,
          q.search
            ? or(
                ilike(auditLog.actorUsername, pattern(q.search)),
                ilike(auditLog.targetLabel, pattern(q.search)),
                ilike(auditLog.action, pattern(q.search)),
              )
            : undefined,
        );
        const [rows, [count]] = await Promise.all([
          db
            .select({
              ...getTableColumns(auditLog),
              clientName: organizations.name,
            })
            .from(auditLog)
            .leftJoin(
              organizations,
              eq(organizations.id, auditLog.organizationId),
            )
            .where(where)
            .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
            .limit(q.pageSize)
            .offset(offset),
          db
            .select({ total: sql<number>`count(*)::int` })
            .from(auditLog)
            .where(where),
        ]);
        data = { rows, total: count.total };
      } else if (req.params.section === "notifications") {
        // Platform notices and aggregate quota notices. Camera operations stay in the client application.
        data = listEvents(null, true)
          .filter(
            (e) =>
              !e.cameraId &&
              [
                "quota_warning",
                "quota_critical",
                "quota_exceeded",
                "storage_warning",
                "storage_critical",
              ].includes(e.type),
          )
          .slice(0, 50);
      } else return res.status(404).json({ error: "Unknown console section" });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader(
        "Server-Timing",
        `app;dur=${(performance.now() - started).toFixed(1)}`,
      );
      res.json(data);
    } catch (err) {
      if (err instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: "Invalid filters", details: err.errors });
      console.error("Console query failed:", err);
      res
        .status(500)
        .json({ error: "Unable to load console data. Try again." });
    }
  });
}
