-- 0004 — AI worker orchestration + per-org ingest tokens
--
-- Adds:
--   * camera_analytics            which AI module runs on which camera, plus
--                                 the runtime state the supervisor owns
--   * organizations.ingest_key_hash  per-tenant worker auth token (hash only)
--
-- Camera credential encryption needs NO schema change: ciphertext is stored in
-- the existing text columns and backfillCameraEncryption() rewrites plaintext
-- rows in place on boot.

CREATE TABLE IF NOT EXISTS "camera_analytics" (
  "id"               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"  varchar NOT NULL REFERENCES "organizations"("id"),
  "camera_id"        varchar NOT NULL REFERENCES "cameras"("id") ON DELETE CASCADE,
  "module"           text    NOT NULL,
  "enabled"          boolean NOT NULL DEFAULT true,
  "config"           jsonb,
  "status"           text    NOT NULL DEFAULT 'stopped',
  "pid"              integer,
  "restart_count"    integer NOT NULL DEFAULT 0,
  "last_error"       text,
  "last_started_at"  timestamp,
  "last_heartbeat_at" timestamp,
  "created_at"       timestamp NOT NULL DEFAULT now()
);

-- One binding per (camera, module); the upsert in storage relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS "camera_analytics_camera_module_unique"
  ON "camera_analytics" ("camera_id", "module");

-- Supervisor and dashboards both filter by org.
CREATE INDEX IF NOT EXISTS "camera_analytics_org_idx"
  ON "camera_analytics" ("organization_id");

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "ingest_key_hash" text;

-- Hash lookup on every ingest request must be an index hit, and a token may
-- belong to exactly one organization.
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_ingest_key_hash_unique"
  ON "organizations" ("ingest_key_hash")
  WHERE "ingest_key_hash" IS NOT NULL;
