-- Migration: GStreamer/MediaMTX rewrite schema changes.
-- Applied to the local dev DB via `drizzle-kit push` (this file documents
-- the same change for production deploys that run real migrations).
--
-- IMPORTANT for production deploys with existing user rows: the
-- password -> password_hash change is NOT a plain rename, it needs a
-- bcrypt hash computed in application code. Run in this order:
--   1. Apply this file up through the `password_hash` ADD COLUMN (nullable).
--   2. Run a one-off script that reads every user, computes
--      bcrypt.hash(existingPlaintextPassword, 12), and writes password_hash.
--   3. Apply the remaining ALTER TABLE users statements (SET NOT NULL, DROP password).
-- On a fresh/empty database (no existing users) all three steps can run
-- together since there is no plaintext data to migrate.

ALTER TABLE "cameras" ADD COLUMN "video_codec" text NOT NULL DEFAULT 'h264';
ALTER TABLE "cameras" ADD COLUMN "mediamtx_path" text;
ALTER TABLE "cameras" ADD COLUMN "recording_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "cameras" ADD COLUMN "recording_pid" integer;
ALTER TABLE "cameras" ADD COLUMN "last_health_check_at" timestamp;
ALTER TABLE "cameras" DROP COLUMN IF EXISTS "is_streaming";
ALTER TABLE "cameras" DROP COLUMN IF EXISTS "last_stream_pid";
ALTER TABLE "cameras" DROP COLUMN IF EXISTS "hls_path";

ALTER TABLE "users" ADD COLUMN "password_hash" text;
-- (bcrypt backfill step runs here in application code for non-empty tables)
UPDATE "users" SET "password_hash" = "password" WHERE "password_hash" IS NULL AND "password" IS NOT NULL;
ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL;
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";

-- "session" table is intentionally NOT managed here — connect-pg-simple
-- creates it itself via createTableIfMissing: true (see server/auth.ts).
