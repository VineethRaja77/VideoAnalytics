// The physical hierarchy: group → site → building → floor → zone.
//
// Four failures this must never allow, each of which is silent or fatal:
//   1. a CYCLE — moving a building under its own floor makes every ancestor
//      walk loop forever and takes the server down
//   2. a CROSS-TENANT parent — one client's cameras inside another's tree
//   3. a STALE SUBTREE PATH after a move — "everything under Tower B" quietly
//      returns the wrong set from then on
//   4. SILENTLY ORPHANED cameras when a floor is deleted

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("locations");

const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const {
  createLocation, moveLocation, deleteLocation, locationTree,
  subtreeIds, camerasInSubtree, breadcrumb, assign, unassigned,
  LocationError, MAX_DEPTH,
} = await import("../locations");
const { storage, db } = await import("../storage");
const { cameras } = await import("@shared/schema");

let ORG_A = "";
let ORG_B = "";

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  ORG_A = (await storage.createOrganization({ name: "Client A", slug: "loc-a" })).id;
  ORG_B = (await storage.createOrganization({ name: "Client B", slug: "loc-b" })).id;
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

async function makeCamera(orgId: string, name: string, locationId?: string) {
  const [c] = await db.insert(cameras).values({
    organizationId: orgId,
    channelId: `ch-${Math.random().toString(16).slice(2, 8)}`,
    name,
    streamUrl: "rtsp://10.0.0.1/s",
    streamType: "rtsp",
    locationId: locationId ?? null,
  } as any).returning();
  return c;
}

/* ---------------------------------------------------------------- build */

describe("building a tree", () => {
  it("creates a root with an empty path at depth 0", async () => {
    const root = await createLocation(ORG_A, { name: "Campus", kind: "group" });
    expect(root.path).toBe("/");
    expect(root.depth).toBe(0);
    expect(root.parentId).toBeNull();
  });

  it("nests children with the ancestor path", async () => {
    const site = await createLocation(ORG_A, { name: "Site 1", kind: "site" });
    const bldg = await createLocation(ORG_A, { name: "Tower A", kind: "building", parentId: site.id });
    const floor = await createLocation(ORG_A, { name: "Level 2", kind: "floor", parentId: bldg.id });

    expect(bldg.path).toBe(`/${site.id}/`);
    expect(floor.path).toBe(`/${site.id}/${bldg.id}/`);
    expect(floor.depth).toBe(2);
  });

  it("bounds nesting depth", async () => {
    let parent = await createLocation(ORG_A, { name: "deep-root" });
    for (let i = 0; i < MAX_DEPTH; i++) {
      parent = await createLocation(ORG_A, { name: `d${i}`, parentId: parent.id });
    }
    await expect(createLocation(ORG_A, { name: "too-deep", parentId: parent.id }))
      .rejects.toThrow(/exceed/);
  });
});

/* -------------------------------------------------------- tenant scoping */

describe("tenant isolation", () => {
  it("refuses to parent a node under ANOTHER organization's node", async () => {
    const bSite = await createLocation(ORG_B, { name: "Client B HQ", kind: "site" });
    // A valid id — just not A's. It must not resolve.
    await expect(createLocation(ORG_A, { name: "sneaky", parentId: bSite.id }))
      .rejects.toThrow(/not found/i);
  });

  it("never shows one tenant another's tree", async () => {
    await createLocation(ORG_B, { name: "Client B Vault Room" });
    const tree = await locationTree(ORG_A);
    expect(JSON.stringify(tree)).not.toContain("Vault Room");
  });

  it("refuses to move a node under another tenant's node", async () => {
    const aNode = await createLocation(ORG_A, { name: "a-move-src" });
    const bNode = await createLocation(ORG_B, { name: "b-move-dst" });
    await expect(moveLocation(ORG_A, aNode.id, bNode.id)).rejects.toThrow(/not found/i);
  });
});

/* ----------------------------------------------------------------- move */

describe("moving a subtree", () => {
  it("REJECTS a cycle — a node moved under its own descendant", async () => {
    // The failure that hangs the server: every ancestor walk would loop.
    const site = await createLocation(ORG_A, { name: "cyc-site" });
    const bldg = await createLocation(ORG_A, { name: "cyc-bldg", parentId: site.id });
    const floor = await createLocation(ORG_A, { name: "cyc-floor", parentId: bldg.id });

    await expect(moveLocation(ORG_A, site.id, floor.id)).rejects.toThrow(/own subtree/);
    await expect(moveLocation(ORG_A, bldg.id, floor.id)).rejects.toThrow(/own subtree/);
  });

  it("rejects a node made its own parent", async () => {
    const n = await createLocation(ORG_A, { name: "self-parent" });
    await expect(moveLocation(ORG_A, n.id, n.id)).rejects.toThrow(/own parent/);
  });

  it("REPATHS every descendant, not just the moved node", async () => {
    // A half-applied move leaves descendants pointing at a path their ancestor
    // no longer has, and every subtree query silently returns the wrong set.
    const oldSite = await createLocation(ORG_A, { name: "old-site" });
    const newSite = await createLocation(ORG_A, { name: "new-site" });
    const bldg = await createLocation(ORG_A, { name: "moving-bldg", parentId: oldSite.id });
    const floor = await createLocation(ORG_A, { name: "moving-floor", parentId: bldg.id });
    const zone = await createLocation(ORG_A, { name: "moving-zone", parentId: floor.id });

    await moveLocation(ORG_A, bldg.id, newSite.id);

    const ids = await subtreeIds(ORG_A, newSite.id);
    // Grandchild and great-grandchild must have come along.
    expect(ids).toContain(bldg.id);
    expect(ids).toContain(floor.id);
    expect(ids).toContain(zone.id);
    // And must no longer be under the old parent.
    expect(await subtreeIds(ORG_A, oldSite.id)).not.toContain(zone.id);
  });

  it("shifts descendant depth by the same delta", async () => {
    const root = await createLocation(ORG_A, { name: "depth-root" });
    const mid = await createLocation(ORG_A, { name: "depth-mid", parentId: root.id });
    const leaf = await createLocation(ORG_A, { name: "depth-leaf", parentId: mid.id });
    expect(leaf.depth).toBe(2);

    // Promote mid to a root: everything under it rises one level.
    await moveLocation(ORG_A, mid.id, null);

    const tree = await locationTree(ORG_A);
    const findNode = (nodes: any[]): any => {
      for (const n of nodes) {
        if (n.id === leaf.id) return n;
        const hit = findNode(n.children);
        if (hit) return hit;
      }
      return null;
    };
    expect(findNode(tree).depth).toBe(1);
  });

  it("does not confuse ids that share a prefix", async () => {
    // The path is delimited with '/' at BOTH ends precisely so a prefix match
    // cannot straddle an id boundary.
    const a = await createLocation(ORG_A, { name: "prefix-a" });
    const b = await createLocation(ORG_A, { name: "prefix-b" });
    const childA = await createLocation(ORG_A, { name: "child-of-a", parentId: a.id });

    const idsB = await subtreeIds(ORG_A, b.id);
    expect(idsB).not.toContain(childA.id);
  });
});

/* --------------------------------------------------------------- delete */

describe("deleting", () => {
  it("REFUSES while cameras are still assigned", async () => {
    // Detaching 40 cameras because someone deleted a floor is silent data loss
    // nobody notices until a camera cannot be found.
    const floor = await createLocation(ORG_A, { name: "del-floor" });
    await makeCamera(ORG_A, "Cam On Floor", floor.id);

    await expect(deleteLocation(ORG_A, floor.id)).rejects.toThrow(/camera/i);
  });

  it("REFUSES while child locations exist", async () => {
    const parent = await createLocation(ORG_A, { name: "del-parent" });
    await createLocation(ORG_A, { name: "del-child", parentId: parent.id });
    await expect(deleteLocation(ORG_A, parent.id)).rejects.toThrow(/child location/i);
  });

  it("names what is blocking so the message is actionable", async () => {
    const f = await createLocation(ORG_A, { name: "del-named" });
    await makeCamera(ORG_A, "Blocker Cam", f.id);
    await expect(deleteLocation(ORG_A, f.id)).rejects.toThrow(/Move or delete them first/);
  });

  it("deletes a true leaf", async () => {
    const leaf = await createLocation(ORG_A, { name: "del-leaf" });
    await expect(deleteLocation(ORG_A, leaf.id)).resolves.toBeUndefined();
  });
});

/* ---------------------------------------------------------------- reads */

describe("queries", () => {
  it("returns every camera at or under a node", async () => {
    const site = await createLocation(ORG_A, { name: "q-site" });
    const bldg = await createLocation(ORG_A, { name: "q-bldg", parentId: site.id });
    const floor = await createLocation(ORG_A, { name: "q-floor", parentId: bldg.id });

    await makeCamera(ORG_A, "q-cam-site", site.id);
    await makeCamera(ORG_A, "q-cam-floor", floor.id);

    const names = (await camerasInSubtree(ORG_A, site.id)).map((c) => c.name);
    expect(names).toContain("q-cam-site");
    expect(names).toContain("q-cam-floor");   // three levels down
  });

  it("builds a readable breadcrumb in path order", async () => {
    const site = await createLocation(ORG_A, { name: "Campus North" });
    const bldg = await createLocation(ORG_A, { name: "Tower B", parentId: site.id });
    const floor = await createLocation(ORG_A, { name: "Level 2", parentId: bldg.id });
    expect(await breadcrumb(ORG_A, floor.id)).toEqual(["Campus North", "Tower B", "Level 2"]);
  });

  it("lists cameras not yet placed in the tree", async () => {
    const orgId = (await storage.createOrganization({ name: "Un Co", slug: "un-co" })).id;
    await makeCamera(orgId, "Floating Cam");
    const { cameras: cams } = await unassigned(orgId);
    expect(cams.map((c) => c.name)).toContain("Floating Cam");
  });

  it("assigns and un-assigns a camera", async () => {
    const orgId = (await storage.createOrganization({ name: "As Co", slug: "as-co" })).id;
    const loc = await createLocation(orgId, { name: "as-zone" });
    const cam = await makeCamera(orgId, "Assign Cam");

    await assign(orgId, { type: "camera", id: cam.id }, loc.id);
    expect((await camerasInSubtree(orgId, loc.id)).map((c) => c.id)).toContain(cam.id);

    await assign(orgId, { type: "camera", id: cam.id }, null);
    expect((await unassigned(orgId)).cameras.map((c) => c.id)).toContain(cam.id);
  });

  it("refuses to assign a camera to another tenant's location", async () => {
    const bLoc = await createLocation(ORG_B, { name: "b-zone-assign" });
    const aCam = await makeCamera(ORG_A, "a-cam-assign");
    await expect(assign(ORG_A, { type: "camera", id: aCam.id }, bLoc.id))
      .rejects.toThrow(/not found/i);
  });

  it("cannot orphan a child even by deleting the parent directly in SQL", async () => {
    // The application refuses to delete a node with children, and the FK is the
    // backstop underneath it. Attempting the delete in raw SQL must still fail
    // — an orphan would leave cameras unreachable in the UI with no
    // explanation, so the tree-builder's orphan handling is a belt-and-braces
    // path that should never actually be reached.
    const orgId = (await storage.createOrganization({ name: "Orph Co", slug: "orph-co" })).id;
    const parent = await createLocation(orgId, { name: "orph-parent" });
    await createLocation(orgId, { name: "orph-child", parentId: parent.id });

    await expect(
      setupPool.query(`DELETE FROM ${TEST_SCHEMA}.locations WHERE id = $1`, [parent.id])
    ).rejects.toThrow(/foreign key/i);
  });
});
