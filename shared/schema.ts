import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean as pgBoolean,
  bigint,
  jsonb,
  uniqueIndex,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* -------------------------------------------------------
   PLATFORM: organizations (tenants / clients)
-------------------------------------------------------- */
export const organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("active"), // active | suspended
  // SHA-256 of this org's analytics ingest token. Workers authenticate with the
  // token; only its hash is stored, and it is scoped to ONE org — a token
  // leaked from one on-prem site cannot forge events for another tenant, which
  // a single platform-wide shared key could. The token is high-entropy random,
  // so a fast hash is appropriate here (this is not a user password).
  ingestKeyHash: text("ingest_key_hash").unique(),
  logoDataUrl: text("logo_data_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------
   USERS — now role- and org-aware.
   super_admin ⇒ organizationId is null (platform-level).
-------------------------------------------------------- */
export const ROLES = ["super_admin", "client_admin", "client_manager", "client_employee"] as const;
export type Role = (typeof ROLES)[number];

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash").notNull(),
  organizationId: varchar("organization_id").references(() => organizations.id),
  role: text("role").notNull().default("client_admin"),
  status: text("status").notNull().default("active"), // active | disabled
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------
   PRODUCTS — the licensable modules (vms today; frs/anpr/... later)
-------------------------------------------------------- */
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(), // 'vms', 'frs', 'anpr', ...
  name: text("name").notNull(),
  description: text("description"),
  active: pgBoolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------
   LICENSES — an org's entitlement to a product.
-------------------------------------------------------- */
export const licenses = pgTable(
  "licenses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    productId: varchar("product_id")
      .notNull()
      .references(() => products.id),
    plan: text("plan").notNull().default("trial"), // monthly | yearly | trial | perpetual
    status: text("status").notNull().default("active"), // active | suspended | expired | trial
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    limits: jsonb("limits"), // { maxCameras, maxUsers }
    // Phase 2 (on-prem cryptographic licensing) — nullable for now:
    machineFingerprint: text("machine_fingerprint"),
    signedLicense: text("signed_license"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  },
  (t) => ({
    orgProductUnique: uniqueIndex("licenses_org_product_unique").on(t.organizationId, t.productId),
  })
);

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cameras = pgTable("cameras", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Nullable at the DB layer for zero-downtime migration (backfilled to a
  // default org on boot); treated as required by application logic.
  organizationId: varchar("organization_id").references(() => organizations.id),
  channelId: text("channel_id").notNull(),
  name: text("name").notNull(),
  streamUrl: text("stream_url").notNull(),
  streamType: text("stream_type").notNull(),
  videoCodec: text("video_codec").notNull().default("h264"),

  username: text("username"),
  password: text("password"),

  port: text("port"),
  vendor: text("vendor"),
  streamMode: text("stream_mode"),

  ipAddress: text("ip_address"),

  /** Node in the location tree. Null on installs that predate the hierarchy;
   *  `location` below stays as the free-text fallback. */
  locationId: varchar("location_id"),
  location: text("location"),
  recordingPolicy: text("recording_policy")
    .notNull()
    .default("continuous"),

  status: text("status").notNull().default("inactive"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // Recording/runtime metadata (owned by mediamtxController + recordingWorker)
  mediamtxPath: text("mediamtx_path"),
  recordingEnabled: pgBoolean("recording_enabled").notNull().default(true),
  recordingPid: integer("recording_pid"),
  recordingFolder: text("recording_folder"),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
});

/* -------------------------------------------------------
   CAMERA ANALYTICS — which AI model runs on which camera.

   The licence says what an org MAY run; this says what it HAS turned on, and
   on which camera. One row per (camera, module). The supervisor in
   analyticsWorker.ts owns the runtime columns (status/pid/heartbeat) exactly
   the way recordingWorker owns the recording columns on `cameras`.
-------------------------------------------------------- */
/**
 * MODULE vs FEATURE — the distinction the whole licensing model rests on.
 *
 *   module  = the runtime process that must be spawned  (e.g. "person")
 *   feature = the thing a client actually buys          (e.g. "intrusion")
 *
 * They used to be the same, which meant licensing `person` handed a client all
 * seven of its analytics. A client paying only for intrusion must not receive
 * loitering, crowd density and the rest.
 *
 * One module serves many features because they share a detector and tracker:
 * running six separate processes per camera for six person analytics would cost
 * six times the CPU to compute the same boxes six times.
 */
export const MODULE_FEATURES = {
  ppe: ["ppe_compliance"],
  face: ["face_recognition"],
  vehicle: [
    "vehicle_count",
    "wrong_way",
    "illegal_parking",
    "congestion",
    "triple_riding",
  ],
  person: [
    "intrusion",
    "people_count",
    "loitering",
    "crowd_density",
    "queue_dwell",
    "tailgating",
    "fall",
  ],
  tamper: ["camera_tamper"],
  object: ["object_left", "object_removed"],
  // SENSORS — not a video module. No camera, no RTSP, no GPU: telemetry from
  // physical devices (ultrasonic, pH probes, Modbus meters) evaluated against
  // thresholds. Listed here so the SAME licensing, org-scoping and entitlement
  // machinery covers it; a client buying only fuel_monitoring gets exactly that.
  sensors: [
    "bay_occupancy",     // per-bay parking, ultrasonic
    "tank_level",        // water / diesel level
    "water_quality",     // pH, TDS, turbidity, chlorine
    "fuel_monitoring",   // diesel level + theft detection
    "energy_metering",   // Modbus energy meters
    "leak_detection",    // flow when consumption should be zero
    "equipment_status",  // pump / DG / lift run-fail contacts
  ],
} as const;

export const ANALYTICS_MODULES = Object.keys(MODULE_FEATURES) as [
  keyof typeof MODULE_FEATURES,
  ...(keyof typeof MODULE_FEATURES)[],
];
export type AnalyticsModule = (typeof ANALYTICS_MODULES)[number];

export const ANALYTICS_FEATURES = Object.values(MODULE_FEATURES).flat() as [
  string,
  ...string[],
];
export type AnalyticsFeature = (typeof ANALYTICS_FEATURES)[number];

/** feature -> the module whose worker provides it. */
export const FEATURE_MODULE: Record<string, AnalyticsModule> = Object.fromEntries(
  Object.entries(MODULE_FEATURES).flatMap(([mod, feats]) =>
    (feats as readonly string[]).map((f) => [f, mod as AnalyticsModule])
  )
);

/** Human labels for the admin console and licence rows. */
export const FEATURE_LABELS: Record<string, string> = {
  // --- sensors (no camera, no model) ---
  bay_occupancy: "Parking Bay Occupancy",
  tank_level: "Tank Level Monitoring",
  water_quality: "Water Quality (pH/TDS)",
  fuel_monitoring: "Diesel / Fuel Monitoring",
  energy_metering: "Energy Metering",
  leak_detection: "Water Leak Detection",
  equipment_status: "Equipment Status (Pump/DG)",
  ppe_compliance: "PPE Compliance",
  face_recognition: "Face Recognition",
  vehicle_count: "Vehicle Counting",
  wrong_way: "Wrong-Way Driving",
  illegal_parking: "Illegal Parking",
  congestion: "Traffic Congestion",
  triple_riding: "Triple Riding",
  intrusion: "Intrusion Detection",
  people_count: "People Counting",
  loitering: "Loitering",
  crowd_density: "Crowd Density",
  queue_dwell: "Queue & Dwell Time",
  tailgating: "Tailgating",
  fall: "Fall Detection",
  camera_tamper: "Camera Tampering",
  object_left: "Object Left Behind",
  object_removed: "Object Removed",
};

export const cameraAnalytics = pgTable(
  "camera_analytics",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    cameraId: varchar("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    // What the client bought and what gets licence-checked.
    feature: text("feature").notNull(), // 'intrusion' | 'vehicle_count' | ...
    // Which worker provides it. Derived from FEATURE_MODULE, stored so the
    // supervisor can group rows into one process per (camera, module) without
    // re-deriving it on every watchdog tick.
    module: text("module").notNull(), // 'person' | 'vehicle' | ...
    enabled: pgBoolean("enabled").notNull().default(true),
    // Per-camera worker overrides (COUNT_LINE, thresholds, ZONE_LINE, …).
    // Passed to the worker as environment variables.
    config: jsonb("config"),

    // ---- runtime state, owned by the supervisor ----
    // stopped | starting | running | crashed | unlicensed | needs_config
    // needs_config is NOT a failure: the feature is licensed and the worker is
    // healthy, but a required zone or line has not been drawn yet. Kept
    // distinct from `crashed` so the UI does not send a client looking for a
    // fault, and so the supervisor does not restart-loop a worker that cannot
    // succeed until an operator acts.
    status: text("status").notNull().default("stopped"),
    pid: integer("pid"),
    restartCount: integer("restart_count").notNull().default(0),
    lastError: text("last_error"),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One binding per (camera, FEATURE). A camera can carry several features of
    // the same module — they will share a single worker process.
    cameraFeatureUnique: uniqueIndex("camera_analytics_camera_feature_unique").on(
      t.cameraId,
      t.feature
    ),
  })
);

export const insertCameraAnalyticsSchema = createInsertSchema(cameraAnalytics)
  .pick({ cameraId: true, feature: true, enabled: true, config: true })
  .extend({
    feature: z.enum(ANALYTICS_FEATURES),
    enabled: z.boolean().default(true),
    config: z.record(z.any()).nullable().optional(),
  });

export type CameraAnalytics = typeof cameraAnalytics.$inferSelect;
export type InsertCameraAnalytics = z.infer<typeof insertCameraAnalyticsSchema>;

/* -------------------------------------------------------
   ANALYTICS EVENTS — output of AI model workers (ppe, frs, …).
   Org-scoped so client admins/managers see only their events.
-------------------------------------------------------- */
export const analyticsEvents = pgTable("analytics_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id")
    .notNull()
    .references(() => organizations.id),
  cameraId: varchar("camera_id").references(() => cameras.id),
  module: text("module").notNull(), // 'ppe' | 'frs' | ...
  type: text("type").notNull(), // 'missing_helmet', ...
  trackId: integer("track_id"),
  details: jsonb("details"),
  snapshot: text("snapshot"),
  acknowledged: pgBoolean("acknowledged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recordings = pgTable("recordings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").references(() => organizations.id),
  cameraId: varchar("camera_id")
    .notNull()
    .references(() => cameras.id),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }),
  filePath: text("file_path").notNull(),
  duration: integer("duration"),
  fileSize: bigint("file_size", { mode: "number" }), // ✅ ADDED
});

/* -------------------------------------------------------
   AUDIT LOG — who did what, to what, when, from where.

   Required, not optional. The face module processes biometric data, which is
   "sensitive personal data" under India's DPDP Act 2023; a Data Fiduciary must
   be able to show who accessed it. Beyond compliance it is the only way to
   answer the question a client WILL eventually ask: "who watched that footage?"

   Design constraints that make it trustworthy:
     - append-only: no update or delete path exists in the application
     - written AFTER the action succeeds, so it never claims something that
       did not happen (except explicit `denied` outcomes, which record attempts)
     - org-scoped like everything else: one client cannot read another's trail
     - never stores the value of a secret, only that a secret changed
-------------------------------------------------------- */
export const AUDIT_ACTIONS = [
  "login", "login_failed", "logout",
  "user_created", "user_updated", "user_disabled", "password_changed",
  "camera_created", "camera_updated", "camera_deleted",
  "recording_viewed", "recording_exported", "recording_deleted",
  "snapshot_viewed",
  "analytics_event_acknowledged",
  // Face enrolment is the creation and deletion of BIOMETRIC personal data.
  // Under the DPDP Act 2023 a Data Fiduciary must be able to show who added a
  // person's face to the system and who removed it, so a rejected attempt is
  // recorded as well as a successful one.
  "face_person_enrolled", "face_person_enrol_rejected", "face_person_removed",
  "face_person_renamed",
  // A zone or line is the definition of what counts as a security violation.
  // Moving one changes what the site alerts on, so it is an auditable act.
  "analytics_zone_changed",
  // Taking a copy of the event history out of the system is a disclosure of
  // personal data (who was where, when), so it is recorded like any other read
  // of that data.
  "analytics_events_exported",
  "license_issued", "license_revoked", "license_updated",
  "analytics_binding_changed",
  "ingest_token_minted",
  "organization_created", "organization_updated",
  "access_denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* Every timestamp in this schema is `timestamptz` — an absolute instant, not a
   bare wall clock. A naive column cannot say which zone it was written in, so
   the moment any part of the system runs in local time, old UTC rows and new
   local rows sit in the same column indistinguishable from each other. As an
   instant, Postgres renders it in whatever zone the reader asks for (psql, the
   app and the workers all ask for the site's zone), and nothing anywhere adds
   or subtracts hours by hand. See migrations/0009_timestamps_are_instants.sql. */

export const auditLog = pgTable(
  "audit_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Org the ACTION AFFECTED. Null only for platform-level super_admin acts. */
    organizationId: varchar("organization_id").references(() => organizations.id),
    /** Who. Kept as plain columns too, so the trail survives user deletion. */
    actorId: varchar("actor_id"),
    actorUsername: text("actor_username"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    /** What was acted on: "camera" / "recording" / "license" ... */
    targetType: text("target_type"),
    targetId: varchar("target_id"),
    /** Human-readable label captured at the time (a camera may be renamed later). */
    targetLabel: text("target_label"),
    outcome: text("outcome").notNull().default("success"), // success | denied | error
    /** Extra context. MUST NOT contain passwords, tokens or stream credentials. */
    detail: jsonb("detail"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTimeIdx: index("audit_org_time_idx").on(t.organizationId, t.createdAt),
    actorIdx: index("audit_actor_idx").on(t.actorId),
    actionIdx: index("audit_action_idx").on(t.action),
  })
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type InsertAuditLog = typeof auditLog.$inferInsert;

/* -------------------------------------------------------
   LOCATIONS — the physical hierarchy a real client actually has.

   group -> site -> building -> floor -> zone, to arbitrary depth. Modelled as
   an ADJACENCY LIST (parentId) plus a MATERIALISED PATH, rather than fixed
   columns for each level:

     * fixed columns (site/building/floor) cannot express a campus with two
       towers and a basement car park, and every new level is a migration
     * the path makes "everything under this node" one indexed prefix scan
       instead of a recursive query per dashboard refresh

   The path is built from IDs, never names, so renaming a building does not
   rewrite its subtree.

   Cameras and devices reference a location. Both keep their old free-text
   fields so an existing install keeps working before anything is assigned.
-------------------------------------------------------- */

/** Advisory only — the tree accepts any depth; these label the levels in UI. */
export const LOCATION_KINDS = ["group", "site", "building", "floor", "zone", "area"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const locations = pgTable(
  "locations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** NULL = a root node for this tenant. */
    parentId: varchar("parent_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("zone"),

    /**
     * Materialised ancestor path of IDs, e.g. "/<rootId>/<buildingId>/".
     * Always starts and ends with "/" so a prefix match cannot straddle an id
     * boundary: LIKE '/a/b/%' can never match '/a/bc/'.
     */
    path: text("path").notNull().default("/"),
    /** Root = 0. Bounded so a malformed move cannot build an unbounded chain. */
    depth: integer("depth").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("locations_org_idx").on(t.organizationId),
    pathIdx: index("locations_path_idx").on(t.organizationId, t.path),
    parentIdx: index("locations_parent_idx").on(t.parentId),
  })
);

export type Location = typeof locations.$inferSelect;
export type InsertLocation = typeof locations.$inferInsert;

/* -------------------------------------------------------
   SENSORS — physical devices and their telemetry.

   Deliberately ONE generic model rather than a table per sensor type. Adding
   "water pH" after "diesel level" must be inserting rows, not writing a module:
   the device declares what it measures, and rules are data.

   Tenanted exactly like cameras: every device belongs to an organization and
   every read path filters on it.
-------------------------------------------------------- */

/** What a device measures. Extend freely — this is data, not behaviour. */
export const SENSOR_METRICS = [
  "occupancy",     // 0 = vacant, 1 = occupied
  "level_percent", // tank fill 0-100
  "level_mm",      // raw distance from an ultrasonic head
  "ph",
  "tds_ppm",
  "turbidity_ntu",
  "chlorine_ppm",
  "flow_lpm",
  "volume_litres",
  "energy_kwh",
  "power_kw",
  "voltage",
  "current",
  "temperature_c",
  "humidity_pct",
  "runtime_hours",
  "state",         // generic binary: 1 = running/closed, 0 = stopped/open
] as const;
export type SensorMetric = (typeof SENSOR_METRICS)[number];

export const devices = pgTable(
  "devices",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Stable identifier used in MQTT topics and by the gateway. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** Free-form: "ultrasonic_bay", "ph_probe", "fuel_level", "energy_meter". */
    kind: text("kind").notNull(),
    /** Node in the location tree; supersedes the free-text site/zone below. */
    locationId: varchar("location_id"),
    site: text("site"),
    zone: text("zone"),
    location: text("location"),
    /** Which licensable feature this device serves. */
    feature: text("feature").notNull(),
    enabled: pgBoolean("enabled").notNull().default(true),

    /**
     * Seconds after which silence means UNKNOWN, never "vacant" or "full".
     * A dead sensor read as vacant sends drivers to a full level; a dead tank
     * sensor read as full hides an empty tank. Silence is its own state.
     */
    heartbeatSeconds: integer("heartbeat_seconds").notNull().default(300),

    /**
     * Calibration tracking. A pH electrode drifts and then reports confidently
     * wrong numbers, so a probe past due is flagged rather than trusted.
     * NULL interval = no calibration required (level, flow, energy).
     */
    calibrationIntervalDays: integer("calibration_interval_days"),
    calibratedAt: timestamp("calibrated_at", { withTimezone: true }),

    /** Tank geometry, scale factors, Modbus register map, etc. */
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgExtUnique: uniqueIndex("devices_org_external_unique").on(t.organizationId, t.externalId),
    orgIdx: index("devices_org_idx").on(t.organizationId),
  })
);

export const sensorReadings = pgTable(
  "sensor_readings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    deviceId: varchar("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    unit: text("unit"),
    /**
     * good | suspect | stale — a reading from an uncalibrated probe is stored
     * but marked, so a dashboard can show it without implying it is trusted.
     */
    quality: text("quality").notNull().default("good"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deviceTimeIdx: index("readings_device_time_idx").on(t.deviceId, t.at),
    orgTimeIdx: index("readings_org_time_idx").on(t.organizationId, t.at),
  })
);

/**
 * Threshold rules. `forSeconds` is the debounce: a tank sloshing across the
 * limit for one reading is not a low-fuel event, and without it an operator
 * gets alert-flapping and stops reading alerts entirely.
 */
export const sensorRules = pgTable(
  "sensor_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: varchar("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** NULL = applies to every device of `kind` in the org. */
    deviceId: varchar("device_id").references(() => devices.id, { onDelete: "cascade" }),
    kind: text("kind"),
    metric: text("metric").notNull(),
    op: text("op").notNull(),            // lt | lte | gt | gte | eq | outside
    threshold: doublePrecision("threshold").notNull(),
    /** Upper bound for `outside` (e.g. pH must stay within 6.5-8.5). */
    thresholdHigh: doublePrecision("threshold_high"),
    forSeconds: integer("for_seconds").notNull().default(0),
    severity: text("severity").notNull().default("warning"),
    message: text("message"),
    enabled: pgBoolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("sensor_rules_org_idx").on(t.organizationId),
  })
);

export type Device = typeof devices.$inferSelect;
export type InsertDevice = typeof devices.$inferInsert;
export type SensorReading = typeof sensorReadings.$inferSelect;
export type SensorRule = typeof sensorRules.$inferSelect;

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  email: true,
  passwordHash: true,
  organizationId: true,
  role: true,
  status: true,
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({
  id: true,
  createdAt: true,
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
});

export const insertLicenseSchema = createInsertSchema(licenses).omit({
  id: true,
  issuedAt: true,
});

export const insertCameraSchema = createInsertSchema(cameras)
  .omit({
    id: true,
    organizationId: true, // stamped by the server from the caller's org
    createdAt: true,
    mediamtxPath: true,
    recordingPid: true,
    recordingFolder: true,
    lastStartedAt: true,
    lastHealthCheckAt: true,
  })
  .extend({
    streamUrl: z.string(),
    streamType: z.string().default("rtsp"),
    videoCodec: z.enum(["h264", "h265"]).default("h264"),
    ipAddress: z.string().optional(),
    recordingPolicy: z.string().default("continuous"),
    status: z.string().default("inactive"),
    recordingEnabled: z.boolean().default(true),
    port: z.string().optional(),
    vendor: z.string().optional(),
    streamMode: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  });

export const insertRecordingSchema = createInsertSchema(recordings).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertCamera = z.infer<typeof insertCameraSchema>;
export type Camera = typeof cameras.$inferSelect;
export type InsertRecording = z.infer<typeof insertRecordingSchema>;
export type Recording = typeof recordings.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type License = typeof licenses.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({
  id: true,
  createdAt: true,
  acknowledged: true,
});
export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;