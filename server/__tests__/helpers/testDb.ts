// Integration-test harness: a REAL Postgres schema and the REAL Express app.
//
// Unit tests already cover resolveOrgScope and evaluateLicense in isolation.
// They cannot prove what actually matters commercially: that two paying clients
// on one server never see each other's cameras, events or analytics, and that a
// client only receives the features they bought. That needs the real routes,
// the real session middleware and a real database.
//
// Everything lives in a dedicated `isolation_test` schema so the developer's
// own data in `public` is never touched, read or modified.

import pkg from "pg";
const { Pool } = pkg;

/**
 * Each test FILE gets its own schema.
 *
 * vitest runs files in parallel, and they previously shared one schema: the
 * first file to finish dropped it while another was still using it, producing
 * "schema already exists" and "relation does not exist" failures that look like
 * product bugs but are pure harness collisions.
 */
export function schemaFor(label: string): string {
  return `test_${label.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
}

/** Back-compat default for the original isolation suite. */
export const TEST_SCHEMA = schemaFor("isolation");

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set to run integration tests");
  return url;
}

/** A pool whose every connection is pinned to the test schema. */
export function testPool(schema: string = TEST_SCHEMA): InstanceType<typeof Pool> {
  const pool = new Pool({
    connectionString: baseUrl(),
    // search_path is per-connection, so it must be set on connect rather than
    // once — a pooled connection would otherwise revert to `public` and the
    // tests would silently run against real data.
    options: `-c search_path=${schema}`,
  });
  return pool;
}

/** Create the tables the app needs, inside the test schema only. */
export async function resetSchema(
  pool: InstanceType<typeof Pool>,
  schema: string = TEST_SCHEMA
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}`);

  await pool.query(`
    CREATE TABLE organizations (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      ingest_key_hash text UNIQUE,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE,
      email text UNIQUE,
      password_hash text NOT NULL,
      organization_id varchar REFERENCES organizations(id),
      role text NOT NULL DEFAULT 'client_admin',
      status text NOT NULL DEFAULT 'active',
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE products (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE licenses (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      product_id varchar NOT NULL REFERENCES products(id),
      plan text NOT NULL DEFAULT 'trial',
      status text NOT NULL DEFAULT 'active',
      issued_at timestamp NOT NULL DEFAULT now(),
      expires_at timestamp,
      limits jsonb,
      machine_fingerprint text,
      signed_license text,
      last_validated_at timestamp,
      CONSTRAINT licenses_org_product_unique UNIQUE (organization_id, product_id)
    );

    CREATE TABLE locations (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      parent_id varchar REFERENCES locations(id) ON DELETE RESTRICT,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'zone',
      path text NOT NULL DEFAULT '/',
      depth integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE cameras (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar REFERENCES organizations(id),
      channel_id text NOT NULL,
      name text NOT NULL,
      stream_url text NOT NULL,
      stream_type text NOT NULL,
      video_codec text NOT NULL DEFAULT 'h264',
      username text, password text, port text, vendor text,
      stream_mode text, ip_address text, location text,
      location_id varchar REFERENCES locations(id),
      recording_policy text NOT NULL DEFAULT 'continuous',
      status text NOT NULL DEFAULT 'inactive',
      created_at timestamp NOT NULL DEFAULT now(),
      mediamtx_path text,
      recording_enabled boolean NOT NULL DEFAULT true,
      recording_pid integer, recording_folder text,
      last_started_at timestamp, last_health_check_at timestamp
    );

    CREATE TABLE camera_analytics (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      camera_id varchar NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
      feature text NOT NULL,
      module text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      config jsonb,
      status text NOT NULL DEFAULT 'stopped',
      pid integer,
      restart_count integer NOT NULL DEFAULT 0,
      last_error text,
      last_started_at timestamp,
      last_heartbeat_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT camera_analytics_camera_feature_unique UNIQUE (camera_id, feature)
    );

    CREATE TABLE analytics_events (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      camera_id varchar REFERENCES cameras(id),
      module text NOT NULL,
      type text NOT NULL,
      track_id integer,
      details jsonb,
      snapshot text,
      acknowledged boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE recordings (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar REFERENCES organizations(id),
      camera_id varchar NOT NULL REFERENCES cameras(id),
      start_time timestamp NOT NULL,
      end_time timestamp,
      file_path text NOT NULL,
      duration integer,
      file_size bigint
    );

    CREATE TABLE devices (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      external_id text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      site text, zone text, location text,
      location_id varchar REFERENCES locations(id),
      feature text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      heartbeat_seconds integer NOT NULL DEFAULT 300,
      calibration_interval_days integer,
      calibrated_at timestamp,
      config jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT devices_org_external_unique UNIQUE (organization_id, external_id)
    );

    CREATE TABLE sensor_readings (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      device_id varchar NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      metric text NOT NULL,
      value double precision NOT NULL,
      unit text,
      quality text NOT NULL DEFAULT 'good',
      at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE sensor_rules (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id),
      device_id varchar REFERENCES devices(id) ON DELETE CASCADE,
      kind text,
      metric text NOT NULL,
      op text NOT NULL,
      threshold double precision NOT NULL,
      threshold_high double precision,
      for_seconds integer NOT NULL DEFAULT 0,
      severity text NOT NULL DEFAULT 'warning',
      message text,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE audit_log (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar REFERENCES organizations(id),
      actor_id varchar,
      actor_username text,
      actor_role text,
      action text NOT NULL,
      target_type text,
      target_id varchar,
      target_label text,
      outcome text NOT NULL DEFAULT 'success',
      detail jsonb,
      ip_address text,
      user_agent text,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE session (
      sid varchar PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    );
  `);
}

export async function dropSchema(
  pool: InstanceType<typeof Pool>,
  schema: string = TEST_SCHEMA
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}
