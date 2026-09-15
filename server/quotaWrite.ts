import { db } from "./storage";
import { cameras, users, locations, licenses, products } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CountLimit = "maxCameras" | "maxUsers" | "maxSites";
export class QuotaError extends Error {
  readonly status = 403;
}

/** Serialize check + insert across processes, scoped to the client's allowance.
 * The lock is released on commit/rollback; no connection or lock survives failure. */
export async function quotaWrite<T>(
  orgId: string,
  key: CountLimit,
  write: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":" + key}, 0))`,
    );
    const [license] = await tx
      .select({ limits: licenses.limits })
      .from(licenses)
      .innerJoin(products, eq(products.id, licenses.productId))
      .where(and(eq(licenses.organizationId, orgId), eq(products.key, "vms")));
    const cap = Number(
      (license?.limits as Record<string, unknown> | null)?.[key],
    );
    if (Number.isFinite(cap) && cap > 0) {
      const table =
        key === "maxCameras" ? cameras : key === "maxUsers" ? users : locations;
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(
          and(
            eq(table.organizationId, orgId),
            key === "maxSites" ? eq(locations.kind, "site") : undefined,
          ),
        );
      if (row.n >= cap) {
        const label =
          key === "maxCameras"
            ? "Cameras"
            : key === "maxUsers"
              ? "Users"
              : "Sites";
        throw new QuotaError(
          `${label} limit reached — your plan allows ${cap} and you have ${row.n}. Contact your provider to raise it.`,
        );
      }
    }
    return write(tx);
  });
}
