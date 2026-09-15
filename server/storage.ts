// server/storage.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;

import { eq, and, gte, lte, lt, desc, sql, count as sqlCount } from "drizzle-orm";
import {
  cameras,
  users,
  recordings,
  organizations,
  products,
  licenses,
  analyticsEvents,
  cameraAnalytics,
} from "@shared/schema";
import { FEATURE_MODULE } from "@shared/schema";

/** Filters a client can apply to their own event history. */
export interface AnalyticsEventQuery {
  module?: string;
  cameraId?: string;
  type?: string;
  /** true = only acknowledged, false = only open. Undefined = both. */
  acknowledged?: boolean;
  /** Inclusive lower bound / exclusive upper bound on createdAt. */
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * One place the filters are turned into SQL, so the LIST and the COUNT can
 * never disagree. Two copies would eventually differ and the UI would report a
 * total that does not match the rows under it.
 */
function analyticsEventConditions(organizationId: string, opts: AnalyticsEventQuery) {
  const c = [eq(analyticsEvents.organizationId, organizationId)];
  if (opts.module) c.push(eq(analyticsEvents.module, opts.module));
  if (opts.cameraId) c.push(eq(analyticsEvents.cameraId, opts.cameraId));
  if (opts.type) c.push(eq(analyticsEvents.type, opts.type));
  if (opts.acknowledged !== undefined) {
    c.push(eq(analyticsEvents.acknowledged, opts.acknowledged));
  }
  if (opts.from) c.push(gte(analyticsEvents.createdAt, opts.from));
  // Exclusive, so a caller can pass midnight of the next day and get exactly
  // one day without the last second belonging to two ranges.
  if (opts.to) c.push(lt(analyticsEvents.createdAt, opts.to));
  return c;
}
import type {
  Camera,
  InsertCamera,
  User,
  InsertUser,
  Recording,
  InsertRecording,
  Organization,
  InsertOrganization,
  Product,
  InsertProduct,
  License,
  InsertLicense,
  AnalyticsEvent,
  InsertAnalyticsEvent,
  CameraAnalytics,
  InsertCameraAnalytics,
} from "@shared/schema";
import { encryptSecret, decryptSecret, isEncrypted, encryptionAvailable } from "./crypto";
import "dotenv/config";
import { quotaWrite } from "./quotaWrite";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool);

/* -------------------------------------------------------
   Camera secret encryption (see the CAMERAS section below)
-------------------------------------------------------- */
const CAMERA_SECRET_FIELDS = ["streamUrl", "password"] as const;

/** Encrypt secret fields on the way into the database. */
function encryptCameraSecrets<T extends Record<string, any>>(input: T): T {
  const out: Record<string, any> = { ...input };
  for (const f of CAMERA_SECRET_FIELDS) {
    if (out[f] !== undefined && out[f] !== null && out[f] !== "") {
      out[f] = encryptSecret(String(out[f]));
    }
  }
  return out as T;
}

/**
 * Decrypt secret fields on the way out.
 *
 * decryptSecret passes legacy plaintext through unchanged, so installs that
 * predate encryption keep working until `backfillCameraEncryption` re-writes
 * them. A row that fails to decrypt yields null rather than leaking ciphertext
 * into an RTSP URL.
 */
function decryptCamera(row: Camera): Camera {
  const out: Record<string, any> = { ...row };
  for (const f of CAMERA_SECRET_FIELDS) {
    if (out[f]) out[f] = decryptSecret(String(out[f]));
  }
  return out as Camera;
}

/**
 * One-time migration: re-write any plaintext camera secrets as ciphertext.
 * Idempotent — encryptSecret leaves already-encrypted values alone — so it is
 * safe to run on every boot.
 */
export async function backfillCameraEncryption(): Promise<void> {
  if (!encryptionAvailable()) {
    console.warn(
      "⚠ SECRET_ENCRYPTION_KEY not set — running with ALLOW_PLAINTEXT_SECRETS.\n" +
        "  Camera stream URLs and passwords are stored UNENCRYPTED. Development only.\n" +
        "  Generate a key with:  openssl rand -base64 32"
    );
    return;
  }
  const rows = await db.select().from(cameras);
  let migrated = 0;
  for (const row of rows) {
    const patch: Record<string, any> = {};
    for (const f of CAMERA_SECRET_FIELDS) {
      const v = (row as any)[f];
      if (v && !isEncrypted(String(v))) patch[f] = encryptSecret(String(v));
    }
    if (Object.keys(patch).length) {
      await db.update(cameras).set(patch).where(eq(cameras.id, row.id));
      migrated++;
    }
  }
  if (migrated) console.log(`🔒 Encrypted credentials for ${migrated} camera(s)`);
}

export const storage = {
  // ===== USERS =====
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  },

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  },

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  },

  /** Login accepts either an email or a username in the same field. */
  async getUserByLogin(login: string): Promise<User | undefined> {
    return (await this.getUserByEmail(login)) ?? (await this.getUserByUsername(login));
  },

  async createUser(user: InsertUser): Promise<User> {
    const insert = async (executor: any) => (await executor.insert(users).values(user).returning())[0] as User;
    return user.organizationId ? quotaWrite(user.organizationId, "maxUsers", insert) : insert(db);
  },

  async updateUserPasswordHash(id: string, passwordHash: string): Promise<void> {
    await db.update(users).set({ passwordHash }).where(eq(users.id, id));
  },

  async getUsersByOrg(organizationId: string): Promise<User[]> {
    return await db.select().from(users).where(eq(users.organizationId, organizationId));
  },

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  },

  async setUserStatus(id: string, status: string): Promise<void> {
    await db.update(users).set({ status }).where(eq(users.id, id));
  },

  async deleteUser(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  },

  // ===== ORGANIZATIONS =====
  async getAllOrganizations(): Promise<Organization[]> {
    return await db.select().from(organizations).orderBy(desc(organizations.createdAt));
  },

  async getOrganization(id: string): Promise<Organization | undefined> {
    const result = await db.select().from(organizations).where(eq(organizations.id, id));
    return result[0];
  },

  async getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
    const result = await db.select().from(organizations).where(eq(organizations.slug, slug));
    return result[0];
  },

  async createOrganization(org: InsertOrganization): Promise<Organization> {
    const result = await db.insert(organizations).values(org).returning();
    return result[0];
  },

  async updateOrganization(id: string, updates: Partial<InsertOrganization>): Promise<Organization | undefined> {
    const result = await db.update(organizations).set(updates).where(eq(organizations.id, id)).returning();
    return result[0];
  },

  /** Store the hash of a freshly minted ingest token (rotates any previous one). */
  async setOrgIngestKeyHash(id: string, ingestKeyHash: string): Promise<void> {
    await db.update(organizations).set({ ingestKeyHash }).where(eq(organizations.id, id));
  },

  /** Resolve the org a worker token belongs to. Hash lookup, no scan. */
  async getOrganizationByIngestKeyHash(hash: string): Promise<Organization | undefined> {
    const result = await db.select().from(organizations).where(eq(organizations.ingestKeyHash, hash));
    return result[0];
  },

  // ===== PRODUCTS (modules) =====
  async getAllProducts(): Promise<Product[]> {
    return await db.select().from(products);
  },

  async getProductByKey(key: string): Promise<Product | undefined> {
    const result = await db.select().from(products).where(eq(products.key, key));
    return result[0];
  },

  async createProduct(product: InsertProduct): Promise<Product> {
    const result = await db.insert(products).values(product).returning();
    return result[0];
  },

  async upsertProduct(product: InsertProduct): Promise<Product> {
    const existing = await this.getProductByKey(product.key);
    if (existing) return existing;
    return this.createProduct(product);
  },

  // ===== LICENSES =====
  async getLicensesByOrg(organizationId: string): Promise<License[]> {
    return await db.select().from(licenses).where(eq(licenses.organizationId, organizationId));
  },

  async getAllLicenses(): Promise<License[]> {
    return await db.select().from(licenses);
  },

  async getLicense(id: string): Promise<License | undefined> {
    const result = await db.select().from(licenses).where(eq(licenses.id, id));
    return result[0];
  },

  /** The single license row for (org, productKey), if any. */
  async getEffectiveLicense(organizationId: string, productKey: string): Promise<License | undefined> {
    const product = await this.getProductByKey(productKey);
    if (!product) return undefined;
    const result = await db
      .select()
      .from(licenses)
      .where(and(eq(licenses.organizationId, organizationId), eq(licenses.productId, product.id)));
    return result[0];
  },

  async createLicense(license: InsertLicense): Promise<License> {
    const result = await db.insert(licenses).values(license).returning();
    return result[0];
  },

  async updateLicense(id: string, updates: Partial<InsertLicense>): Promise<License | undefined> {
    const result = await db.update(licenses).set(updates).where(eq(licenses.id, id)).returning();
    return result[0];
  },

  async deleteLicense(id: string): Promise<void> {
    await db.delete(licenses).where(eq(licenses.id, id));
  },

  // ===== CAMERAS =====
  //
  // Camera secrets are encrypted AT THE STORAGE LAYER: written encrypted,
  // returned decrypted. Every existing consumer (mediamtxController,
  // recordingWorker, analyticsWorker, routes) keeps seeing plaintext and needs
  // no change, while nothing readable ever reaches Postgres.
  //
  // `streamUrl` is treated as a secret, not just `password`: an RTSP URL is
  // normally rtsp://user:pass@host/path, so the URL *is* the credential.

  /** Cross-org: used by super-admin views and recorder infrastructure. */
  async getAllCameras(): Promise<Camera[]> {
    return (await db.select().from(cameras)).map(decryptCamera);
  },

  async getCamerasByOrg(organizationId: string): Promise<Camera[]> {
    return (
      await db.select().from(cameras).where(eq(cameras.organizationId, organizationId))
    ).map(decryptCamera);
  },

  async getCamera(id: string): Promise<Camera | undefined> {
    const result = await db.select().from(cameras).where(eq(cameras.id, id));
    return result[0] ? decryptCamera(result[0]) : undefined;
  },

  /** Returns the camera only if it belongs to the given org (tenant isolation). */
  async getCameraForOrg(id: string, organizationId: string): Promise<Camera | undefined> {
    const result = await db
      .select()
      .from(cameras)
      .where(and(eq(cameras.id, id), eq(cameras.organizationId, organizationId)));
    return result[0] ? decryptCamera(result[0]) : undefined;
  },

  async createCamera(camera: InsertCamera, organizationId: string): Promise<Camera> {
    return quotaWrite(organizationId, "maxCameras", async (tx) => {
      const [row] = await tx.insert(cameras).values({ ...encryptCameraSecrets(camera), organizationId }).returning();
      return decryptCamera(row);
    });
  },

  async countCamerasByOrg(organizationId: string): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(cameras).where(eq(cameras.organizationId, organizationId));
    return row.n;
  },

  async updateCamera(id: string, updates: Partial<InsertCamera>): Promise<Camera | undefined> {
    const result = await db
      .update(cameras)
      .set(encryptCameraSecrets(updates))
      .where(eq(cameras.id, id))
      .returning();
    return result[0] ? decryptCamera(result[0]) : undefined;
  },

  async updateCameraStatus(id: string, status: string): Promise<Camera | undefined> {
    const result = await db.update(cameras).set({ status }).where(eq(cameras.id, id)).returning();
    return result[0] ? decryptCamera(result[0]) : undefined;
  },

  async deleteCamera(id: string): Promise<boolean> {
    await db.delete(recordings).where(eq(recordings.cameraId, id));
    console.log(`🗑️ Deleted recordings for camera: ${id}`);

    const result = await db.delete(cameras).where(eq(cameras.id, id)).returning();
    return result.length > 0;
  },

  // ===== RECORDING METADATA HELPERS (owned by mediamtxController + recordingWorker) =====
  async setRecordingMetadata(
    id: string,
    metadata: {
      mediamtxPath?: string | null;
      recordingPid?: number | null;
      recordingFolder?: string | null;
      lastStartedAt?: Date | null;
      lastHealthCheckAt?: Date | null;
    }
  ): Promise<Camera | undefined> {
    const updates: any = {};
    if (typeof metadata.mediamtxPath !== "undefined") updates.mediamtxPath = metadata.mediamtxPath;
    if (typeof metadata.recordingPid !== "undefined") updates.recordingPid = metadata.recordingPid;
    if (typeof metadata.recordingFolder !== "undefined") updates.recordingFolder = metadata.recordingFolder;
    if (typeof metadata.lastStartedAt !== "undefined") updates.lastStartedAt = metadata.lastStartedAt;
    if (typeof metadata.lastHealthCheckAt !== "undefined") updates.lastHealthCheckAt = metadata.lastHealthCheckAt;

    const result = await db.update(cameras).set(updates).where(eq(cameras.id, id)).returning();
    return result[0];
  },

  async clearRecordingMetadata(id: string): Promise<Camera | undefined> {
    const result = await db
      .update(cameras)
      .set({
        recordingPid: null,
        lastStartedAt: null,
      })
      .where(eq(cameras.id, id))
      .returning();
    return result[0];
  },

  /** Recorder infrastructure runs across all orgs, so this stays global. */
  async getRecordingEnabledCameras(): Promise<Camera[]> {
    // decryptCamera is NOT optional here. This is the boot path: without it the
    // recorder and MediaMTX receive the raw ciphertext as a stream URL, MediaMTX
    // rejects it with "invalid source", and recording silently never resumes
    // after a restart — for every camera at once. Every other camera getter
    // decrypts; this one was missed.
    return (
      await db.select().from(cameras).where(eq(cameras.recordingEnabled, true))
    ).map(decryptCamera);
  },

  // ===== RECORDINGS =====
  async getRecordingsByCamera(
    cameraId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<Recording[]> {
    const conditions = [eq(recordings.cameraId, cameraId)];

    if (startDate && endDate) {
      // Overlap semantics: any recording whose footage intersects the window,
      // not just those that *started* inside it — a segment running 23:40→23:50
      // must show up in a 23:45→00:30 search.
      conditions.push(
        lte(recordings.startTime, endDate),
        gte(recordings.endTime, startDate)
      );
    }

    return await db
      .select()
      .from(recordings)
      .where(and(...conditions));
  },

  async createRecording(recording: InsertRecording): Promise<Recording> {
    const result = await db.insert(recordings).values(recording).returning();
    return result[0];
  },

  async getRecordingByFilePath(cameraId: string, filePath: string): Promise<Recording | undefined> {
    const result = await db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.cameraId, cameraId),
          eq(recordings.filePath, filePath)
        )
      );
    return result[0];
  },

  async deleteRecordingsByCamera(cameraId: string): Promise<number> {
    const result = await db.delete(recordings).where(eq(recordings.cameraId, cameraId)).returning();
    return result.length;
  },

  // ===== ANALYTICS EVENTS (AI model outputs) =====
  async createAnalyticsEvent(event: InsertAnalyticsEvent): Promise<AnalyticsEvent> {
    const result = await db.insert(analyticsEvents).values(event).returning();
    return result[0];
  },

  /**
   * Events for one organisation, filtered.
   *
   * The list used to be "the newest 200, and nothing else". A week after
   * go-live a client cannot answer "what happened at Gate 2 on Tuesday", which
   * is the question a security system exists to answer, so date, camera, type
   * and acknowledgement are all filterable and the result can be paged.
   */
  async getAnalyticsEventsByOrg(
    organizationId: string,
    opts: AnalyticsEventQuery = {}
  ): Promise<AnalyticsEvent[]> {
    return await db
      .select()
      .from(analyticsEvents)
      .where(and(...analyticsEventConditions(organizationId, opts)))
      .orderBy(desc(analyticsEvents.createdAt))
      .limit(Math.min(opts.limit ?? 100, 5000))
      .offset(opts.offset ?? 0);
  },

  /**
   * How many events match, ignoring limit/offset.
   *
   * Without it the UI cannot say "showing 50 of 1,284" — and a list that always
   * looks complete hides the fact that a filter is needed at all.
   */
  async countAnalyticsEventsByOrg(
    organizationId: string,
    opts: AnalyticsEventQuery = {}
  ): Promise<number> {
    const rows = await db
      .select({ n: sqlCount() })
      .from(analyticsEvents)
      .where(and(...analyticsEventConditions(organizationId, opts)));
    return Number(rows[0]?.n ?? 0);
  },

  async acknowledgeAnalyticsEvent(id: string, organizationId: string): Promise<void> {
    await db
      .update(analyticsEvents)
      .set({ acknowledged: true })
      .where(and(eq(analyticsEvents.id, id), eq(analyticsEvents.organizationId, organizationId)));
  },

  // ===== CAMERA ANALYTICS (which model runs on which camera) =====
  async getCameraAnalytics(id: string): Promise<CameraAnalytics | undefined> {
    const r = await db.select().from(cameraAnalytics).where(eq(cameraAnalytics.id, id));
    return r[0];
  },

  async getCameraAnalyticsByCamera(cameraId: string): Promise<CameraAnalytics[]> {
    return await db.select().from(cameraAnalytics).where(eq(cameraAnalytics.cameraId, cameraId));
  },

  async getCameraAnalyticsByOrg(organizationId: string): Promise<CameraAnalytics[]> {
    return await db
      .select()
      .from(cameraAnalytics)
      .where(eq(cameraAnalytics.organizationId, organizationId))
      .orderBy(desc(cameraAnalytics.createdAt));
  },

  /** Every binding across all orgs — the supervisor's view at boot. */
  async getAllCameraAnalytics(): Promise<CameraAnalytics[]> {
    return await db.select().from(cameraAnalytics);
  },

  /** Enable a FEATURE on a camera, or update its config if already bound.
   *  The owning module is derived here so callers never have to know it. */
  async upsertCameraAnalytics(
    row: InsertCameraAnalytics & { organizationId: string }
  ): Promise<CameraAnalytics> {
    const module = FEATURE_MODULE[row.feature];
    if (!module) throw new Error(`Unknown analytics feature: ${row.feature}`);
    const result = await db
      .insert(cameraAnalytics)
      .values({
        organizationId: row.organizationId,
        cameraId: row.cameraId,
        feature: row.feature,
        module,
        enabled: row.enabled ?? true,
        config: row.config ?? null,
      })
      .onConflictDoUpdate({
        target: [cameraAnalytics.cameraId, cameraAnalytics.feature],
        set: { enabled: row.enabled ?? true, config: row.config ?? null, module },
      })
      .returning();
    return result[0];
  },

  /** All bindings for one (camera, module) — the set a single worker serves. */
  async getCameraAnalyticsByCameraModule(
    cameraId: string,
    module: string
  ): Promise<CameraAnalytics[]> {
    return await db
      .select()
      .from(cameraAnalytics)
      .where(and(eq(cameraAnalytics.cameraId, cameraId), eq(cameraAnalytics.module, module)));
  },

  async setCameraAnalyticsEnabled(id: string, enabled: boolean): Promise<void> {
    await db.update(cameraAnalytics).set({ enabled }).where(eq(cameraAnalytics.id, id));
  },

  /** Runtime state write — supervisor only. */
  async updateCameraAnalyticsRuntime(
    id: string,
    patch: Partial<
      Pick<
        CameraAnalytics,
        "status" | "pid" | "restartCount" | "lastError" | "lastStartedAt" | "lastHeartbeatAt"
      >
    >
  ): Promise<void> {
    await db.update(cameraAnalytics).set(patch).where(eq(cameraAnalytics.id, id));
  },

  async deleteCameraAnalytics(id: string): Promise<void> {
    await db.delete(cameraAnalytics).where(eq(cameraAnalytics.id, id));
  },
};
