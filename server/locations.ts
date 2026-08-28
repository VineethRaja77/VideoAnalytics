// server/locations.ts
//
// The physical hierarchy: group → site → building → floor → zone, any depth.
//
// Adjacency list (parentId) + materialised path. The path is the reason this
// is usable at scale: "every camera under Tower B" is one indexed prefix scan
// rather than a recursive walk per dashboard refresh.
//
// FOUR THINGS MUST NOT HAPPEN, and each has a guard here:
//
//   1. A CYCLE. Moving a building under its own floor makes every ancestor walk
//      loop forever and takes the server down. Rejected before the write.
//   2. A CROSS-TENANT PARENT. Re-parenting under another org's node would place
//      one client's cameras inside another's tree.
//   3. A STALE SUBTREE PATH. Moving a node must repath every descendant in the
//      same transaction, or "everything under Tower B" silently starts
//      returning the wrong set.
//   4. SILENTLY ORPHANED CAMERAS. Deleting a floor that still holds 40 cameras
//      must fail loudly, not detach them where nobody will look.

import { db } from "./storage";
import { locations, cameras, devices, type Location } from "@shared/schema";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";

/** Guards against a runaway chain built by a malformed move. */
export const MAX_DEPTH = 12;

export class LocationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Path of a node = parent's path + parent's id + "/". Root = "/". */
function childPath(parent: Location | null): string {
  return parent ? `${parent.path}${parent.id}/` : "/";
}

async function getScoped(orgId: string, id: string): Promise<Location | null> {
  const rows = await db
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
  return rows[0] ?? null;
}

/* ----------------------------------------------------------------- create */

export async function createLocation(
  orgId: string,
  input: { name: string; kind?: string; parentId?: string | null }
): Promise<Location> {
  let parent: Location | null = null;

  if (input.parentId) {
    // Scoped read: a parent id belonging to another tenant simply does not
    // resolve, so a crafted request cannot graft onto their tree.
    parent = await getScoped(orgId, input.parentId);
    if (!parent) throw new LocationError("Parent location not found", 404);
    if (parent.depth + 1 > MAX_DEPTH) {
      throw new LocationError(`Location nesting cannot exceed ${MAX_DEPTH} levels`);
    }
  }

  const [created] = await db
    .insert(locations)
    .values({
      organizationId: orgId,
      parentId: parent?.id ?? null,
      name: input.name,
      kind: input.kind ?? "zone",
      path: childPath(parent),
      depth: parent ? parent.depth + 1 : 0,
    })
    .returning();
  return created;
}

/* ------------------------------------------------------------------- move */

/**
 * Re-parent a node and repath its whole subtree.
 *
 * Runs in ONE transaction: a half-applied move leaves descendants pointing at
 * a path their ancestor no longer has, and every subtree query silently
 * returns the wrong set from then on.
 */
export async function moveLocation(
  orgId: string,
  id: string,
  newParentId: string | null
): Promise<Location> {
  const node = await getScoped(orgId, id);
  if (!node) throw new LocationError("Location not found", 404);

  let parent: Location | null = null;
  if (newParentId) {
    if (newParentId === id) {
      throw new LocationError("A location cannot be its own parent");
    }
    parent = await getScoped(orgId, newParentId);
    if (!parent) throw new LocationError("Parent location not found", 404);

    // THE CYCLE CHECK. The candidate parent must not sit inside this node's
    // own subtree. Its path contains every ancestor id, so a substring test is
    // sufficient and cheap — no recursive walk that could itself loop.
    const selfPrefix = `${node.path}${node.id}/`;
    if (parent.path === selfPrefix || parent.path.startsWith(selfPrefix)) {
      throw new LocationError(
        `Cannot move "${node.name}" under "${parent.name}" — that would put it inside its own subtree`
      );
    }
  }

  const oldPrefix = `${node.path}${node.id}/`;
  const newPath = childPath(parent);
  const newPrefix = `${newPath}${node.id}/`;
  const depthShift = (parent ? parent.depth + 1 : 0) - node.depth;

  // Deepest descendant must still fit under the cap after the shift.
  const deepest = await db
    .select({ maxDepth: sql<number>`coalesce(max(${locations.depth}), 0)` })
    .from(locations)
    .where(and(eq(locations.organizationId, orgId), like(locations.path, `${oldPrefix}%`)));
  const maxAfter = (Number(deepest[0]?.maxDepth ?? node.depth)) + depthShift;
  if (maxAfter > MAX_DEPTH) {
    throw new LocationError(`That move would nest deeper than ${MAX_DEPTH} levels`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(locations)
      .set({ parentId: parent?.id ?? null, path: newPath, depth: parent ? parent.depth + 1 : 0 })
      .where(eq(locations.id, node.id));

    // Rewrite the subtree in one statement: replace the old ancestor prefix
    // with the new one and shift depth by the same delta.
    // The offsets are computed here, not taken from input, so casting them
    // explicitly is safe. Without the ::int cast the driver binds them as text
    // and `substring(path from $n)` evaluates to NULL, which then violates the
    // NOT NULL on path — a failure that only appears on a move with children.
    await tx.execute(sql`
      UPDATE locations
         SET path  = ${newPrefix} || substring(path from ${oldPrefix.length + 1}::int),
             depth = depth + ${depthShift}::int
       WHERE organization_id = ${orgId}
         AND path LIKE ${oldPrefix + "%"}
    `);
  });

  return (await getScoped(orgId, id))!;
}

/* ----------------------------------------------------------------- delete */

export interface DeleteBlockers {
  children: number;
  cameras: number;
  devices: number;
}

/**
 * Delete a leaf.
 *
 * Refuses while anything still references it. Detaching 40 cameras because
 * someone deleted a floor is the kind of silent data loss nobody notices until
 * a camera cannot be found; the caller must move them first.
 */
export async function deleteLocation(orgId: string, id: string): Promise<void> {
  const node = await getScoped(orgId, id);
  if (!node) throw new LocationError("Location not found", 404);

  const [kids, cams, devs] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(locations).where(eq(locations.parentId, id)),
    db.select({ n: sql<number>`count(*)` }).from(cameras).where(eq(cameras.locationId, id)),
    db.select({ n: sql<number>`count(*)` }).from(devices).where(eq(devices.locationId, id)),
  ]);

  const blockers: DeleteBlockers = {
    children: Number(kids[0]?.n ?? 0),
    cameras: Number(cams[0]?.n ?? 0),
    devices: Number(devs[0]?.n ?? 0),
  };

  if (blockers.children || blockers.cameras || blockers.devices) {
    const parts = [
      blockers.children && `${blockers.children} child location(s)`,
      blockers.cameras && `${blockers.cameras} camera(s)`,
      blockers.devices && `${blockers.devices} device(s)`,
    ].filter(Boolean);
    throw new LocationError(
      `"${node.name}" still contains ${parts.join(", ")}. Move or delete them first.`,
      409
    );
  }

  await db.delete(locations).where(eq(locations.id, id));
}

/* ------------------------------------------------------------------ reads */

export interface LocationNode extends Location {
  children: LocationNode[];
  cameraCount: number;
  deviceCount: number;
}

/**
 * The whole tree for one tenant, with per-node counts.
 *
 * Three queries total regardless of tree size — assembling the tree in memory
 * beats a query per node on a client with hundreds of zones.
 */
export async function locationTree(orgId: string): Promise<LocationNode[]> {
  const [rows, camRows, devRows] = await Promise.all([
    db.select().from(locations).where(eq(locations.organizationId, orgId)).orderBy(locations.name),
    db
      .select({ locationId: cameras.locationId, n: sql<number>`count(*)` })
      .from(cameras)
      .where(eq(cameras.organizationId, orgId))
      .groupBy(cameras.locationId),
    db
      .select({ locationId: devices.locationId, n: sql<number>`count(*)` })
      .from(devices)
      .where(eq(devices.organizationId, orgId))
      .groupBy(devices.locationId),
  ]);

  const camBy = new Map(camRows.filter((r) => r.locationId).map((r) => [r.locationId!, Number(r.n)]));
  const devBy = new Map(devRows.filter((r) => r.locationId).map((r) => [r.locationId!, Number(r.n)]));

  const byId = new Map<string, LocationNode>();
  for (const r of rows) {
    byId.set(r.id, {
      ...r,
      children: [],
      cameraCount: camBy.get(r.id) ?? 0,
      deviceCount: devBy.get(r.id) ?? 0,
    });
  }

  const roots: LocationNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A node whose parent is missing is surfaced as a root rather than dropped:
    // hiding it would make cameras unreachable in the UI with no explanation.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Every location id at or under `id` — the prefix scan the path exists for. */
export async function subtreeIds(orgId: string, id: string): Promise<string[]> {
  const node = await getScoped(orgId, id);
  if (!node) return [];
  const prefix = `${node.path}${node.id}/`;
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.organizationId, orgId), like(locations.path, `${prefix}%`)));
  return [node.id, ...rows.map((r) => r.id)];
}

/** Cameras anywhere at or under a node — "show me all of Tower B". */
export async function camerasInSubtree(orgId: string, id: string) {
  const ids = await subtreeIds(orgId, id);
  if (!ids.length) return [];
  return db
    .select()
    .from(cameras)
    .where(and(eq(cameras.organizationId, orgId), inArray(cameras.locationId, ids)));
}

/** Human-readable trail, e.g. "Campus / Tower B / Level 2 / Bay Area". */
export async function breadcrumb(orgId: string, id: string): Promise<string[]> {
  const node = await getScoped(orgId, id);
  if (!node) return [];
  const ancestorIds = node.path.split("/").filter(Boolean);
  if (!ancestorIds.length) return [node.name];

  const rows = await db
    .select()
    .from(locations)
    .where(and(eq(locations.organizationId, orgId), inArray(locations.id, ancestorIds)));

  const byId = new Map(rows.map((r) => [r.id, r.name]));
  // Ordered by the path, not by whatever order the rows came back in.
  return [...ancestorIds.map((a) => byId.get(a) ?? "?"), node.name];
}

/** Cameras and devices not yet placed in the tree. */
export async function unassigned(orgId: string) {
  const [cams, devs] = await Promise.all([
    db.select().from(cameras).where(and(eq(cameras.organizationId, orgId), isNull(cameras.locationId))),
    db.select().from(devices).where(and(eq(devices.organizationId, orgId), isNull(devices.locationId))),
  ]);
  return { cameras: cams, devices: devs };
}

/**
 * Assign a camera or device to a location.
 *
 * Both ids are org-scoped, so a camera cannot be filed under another tenant's
 * building even with a valid location id.
 */
export async function assign(
  orgId: string,
  target: { type: "camera" | "device"; id: string },
  locationId: string | null
): Promise<void> {
  if (locationId) {
    const loc = await getScoped(orgId, locationId);
    if (!loc) throw new LocationError("Location not found", 404);
  }

  const table = target.type === "camera" ? cameras : devices;
  const res = await db
    .update(table)
    .set({ locationId })
    .where(and(eq(table.id, target.id), eq(table.organizationId, orgId)))
    .returning({ id: table.id });

  if (!res.length) throw new LocationError(`${target.type} not found`, 404);
}
