-- 0005 — licence per FEATURE, not per module
--
-- Before: licensing "vehicle" gave a client every vehicle analytic, and
-- licensing "person" would have handed over all seven person analytics at once.
-- A client paying only for intrusion must not receive loitering and the rest.
--
--   module  = the runtime process that gets spawned   (person, vehicle, ...)
--   feature = what the client buys and is billed for  (intrusion, loitering...)
--
-- One module still serves many features: they share a detector and tracker, so
-- the supervisor runs ONE process per (camera, module) and passes it the list
-- of licensed features. Six processes per camera would compute the same boxes
-- six times.

ALTER TABLE "camera_analytics"
  ADD COLUMN IF NOT EXISTS "feature" text;

-- Backfill: every existing row was module-scoped, so its feature is that
-- module's primary analytic.
UPDATE "camera_analytics" SET "feature" = 'ppe_compliance'  WHERE "module" = 'ppe'     AND "feature" IS NULL;
UPDATE "camera_analytics" SET "feature" = 'vehicle_count'   WHERE "module" = 'vehicle' AND "feature" IS NULL;
UPDATE "camera_analytics" SET "feature" = 'face_recognition' WHERE "module" = 'face'   AND "feature" IS NULL;

-- Anything unrecognised keeps working by mirroring the module name.
UPDATE "camera_analytics" SET "feature" = "module" WHERE "feature" IS NULL;

ALTER TABLE "camera_analytics" ALTER COLUMN "feature" SET NOT NULL;

-- The uniqueness constraint moves from (camera, module) to (camera, feature):
-- a camera may now carry several features of the same module.
DROP INDEX IF EXISTS "camera_analytics_camera_module_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "camera_analytics_camera_feature_unique"
  ON "camera_analytics" ("camera_id", "feature");

-- The supervisor groups by (camera, module) on every watchdog tick.
CREATE INDEX IF NOT EXISTS "camera_analytics_camera_module_idx"
  ON "camera_analytics" ("camera_id", "module");

-- Existing per-module licences are renamed to the equivalent feature product so
-- current clients keep exactly the access they already had. seed.ts creates the
-- full per-feature catalogue on boot.
UPDATE "products" SET "key" = 'ppe_compliance',   "name" = 'PPE Compliance'    WHERE "key" = 'ppe';
UPDATE "products" SET "key" = 'vehicle_count',    "name" = 'Vehicle Counting'  WHERE "key" = 'vehicle';
UPDATE "products" SET "key" = 'face_recognition', "name" = 'Face Recognition'  WHERE "key" = 'face';
