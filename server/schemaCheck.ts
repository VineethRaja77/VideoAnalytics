// server/schemaCheck.ts
//
// Verify at boot that the database actually has the shape this build expects.
//
// This exists because of a real incident on a development box: migrations 0004
// and 0005 had never been applied, so `camera_analytics` and
// `organizations.ingest_key_hash` did not exist. The symptoms were a crash
// during seeding and "Failed to restore analytics workers" — neither of which
// says "run your migrations". The test suite passed throughout, because tests
// build their own schema and therefore cannot see drift in the real one.
//
// On a client site this is worse: the installer runs the app, some pages work,
// analytics silently never start, and the fault surfaces days later as
// "the AI features don't do anything".
//
// So the check is explicit, runs before anything else touches the database, and
// names the exact missing object and the migration that creates it.

import { db } from "./storage";
import { sql } from "drizzle-orm";

interface Expectation {
  table: string;
  /** Columns that must exist. Only ones added by later migrations need listing. */
  columns?: string[];
  /** Which migration file creates this, quoted verbatim in the error. */
  migration: string;
}

/**
 * What this build requires. Deliberately hand-maintained rather than derived
 * from the Drizzle schema: the point is to catch the case where the CODE moved
 * ahead of the DATABASE, and generating both from the same source would defeat
 * that.
 */
const EXPECTED: Expectation[] = [
  { table: "organizations", columns: ["ingest_key_hash"], migration: "0004_analytics_workers_and_encryption.sql" },
  { table: "organizations", columns: ["logo_data_url"], migration: "0010_branding.sql" },
  { table: "users", migration: "0000_last_surge.sql" },
  { table: "products", migration: "0001_yummy_outlaw_kid.sql" },
  { table: "licenses", columns: ["signed_license", "machine_fingerprint"], migration: "0002_perfect_scarlet_spider.sql" },
  { table: "cameras", columns: ["mediamtx_path", "recording_enabled"], migration: "0003_gstreamer_mediamtx_rewrite.sql" },
  { table: "camera_analytics", columns: ["feature", "module"], migration: "0005_analytics_features.sql" },
  { table: "analytics_events", columns: ["snapshot", "acknowledged"], migration: "0004_analytics_workers_and_encryption.sql" },
  { table: "recordings", columns: ["file_size"], migration: "0003_gstreamer_mediamtx_rewrite.sql" },
  { table: "audit_log", columns: ["action", "actor_username", "outcome"], migration: "0006_audit_log.sql" },
  { table: "locations", columns: ["parent_id", "path", "depth"], migration: "0008_locations.sql" },
  { table: "devices", columns: ["external_id", "feature", "heartbeat_seconds"], migration: "0007_sensors.sql" },
  { table: "sensor_readings", columns: ["metric", "value", "quality"], migration: "0007_sensors.sql" },
  { table: "sensor_rules", columns: ["op", "threshold", "for_seconds"], migration: "0007_sensors.sql" },
  { table: "platform_settings", columns: ["key", "value"], migration: "0010_branding.sql" },
  { table: "session", migration: "created automatically by connect-pg-simple" },
];

export interface SchemaProblem {
  table: string;
  missingColumns?: string[];
  tableMissing?: boolean;
  migration: string;
}

/** Compare the live database against EXPECTED. Read-only. */
export async function findSchemaProblems(): Promise<SchemaProblem[]> {
  // One round trip: the whole column list for the tables we care about.
  const rows = (await db.execute(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `)) as unknown as { rows: Array<{ table_name: string; column_name: string }> };

  const actual = new Map<string, Set<string>>();
  for (const r of rows.rows ?? []) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }

  const problems: SchemaProblem[] = [];
  for (const exp of EXPECTED) {
    const cols = actual.get(exp.table);
    if (!cols) {
      problems.push({ table: exp.table, tableMissing: true, migration: exp.migration });
      continue;
    }
    const missing = (exp.columns ?? []).filter((c) => !cols.has(c));
    if (missing.length) {
      problems.push({ table: exp.table, missingColumns: missing, migration: exp.migration });
    }
  }
  return problems;
}

/**
 * Configuration that must be present before the app can do its job.
 *
 * Checked at boot rather than at first use. Without this the failure mode is:
 * the server starts, logs a warning that says camera credentials "remain
 * plaintext" — implying it still works — and then the operator's FIRST camera
 * add returns a generic "Failed to create camera", because encryptSecret
 * actually throws. A misleading warning followed by an unexplained 500 is the
 * worst possible first impression on an install.
 *
 * Refusing to start is consistent with SESSION_SECRET, which already does this.
 */
export function assertConfigUsable(): void {
  const problems: string[] = [];

  if (!process.env.SECRET_ENCRYPTION_KEY) {
    if (process.env.ALLOW_PLAINTEXT_SECRETS === "true") {
      console.warn(
        "⚠ SECRET_ENCRYPTION_KEY is not set and ALLOW_PLAINTEXT_SECRETS=true — " +
          "camera stream URLs and passwords WILL BE STORED IN PLAINTEXT. " +
          "Acceptable only for local development, never for a client install."
      );
    } else {
      problems.push(
        "SECRET_ENCRYPTION_KEY is not set. Camera stream URLs and passwords are\n" +
          "    encrypted with it, and adding a camera fails without it.\n" +
          "    Generate one:  openssl rand -base64 32\n" +
          "    (Development only: set ALLOW_PLAINTEXT_SECRETS=true to store them unencrypted.)"
      );
    }
  }

  if (problems.length) {
    console.error(
      `❌ Configuration is incomplete — ${problems.length} problem(s):\n  • ` +
        problems.join("\n  • ")
    );
    throw new Error("Required configuration missing — refusing to start. See the log above.");
  }
}

/**
 * Run the schema check at boot.
 *
 * Fails hard by default. A VMS that starts "mostly working" is the worse
 * outcome: recording may run while analytics silently never start, and the
 * client discovers it days later. Refusing to start is loud, immediate, and
 * fixable in one command.
 *
 * Set ALLOW_SCHEMA_DRIFT=true to downgrade to a warning — for a deliberate
 * partial rollback, never as a way to make the message go away.
 */
export async function assertSchemaCurrent(): Promise<void> {
  let problems: SchemaProblem[];
  try {
    problems = await findSchemaProblems();
  } catch (err) {
    console.error(
      "❌ Could not inspect the database schema. The database is unreachable or " +
        "the configured user cannot read information_schema:",
      err
    );
    throw err;
  }

  if (!problems.length) {
    console.log("🗄  database schema: up to date");
    return;
  }

  const lines = problems.map((p) =>
    p.tableMissing
      ? `  • table "${p.table}" is MISSING            → ${p.migration}`
      : `  • table "${p.table}" is missing column(s): ${p.missingColumns!.join(", ")}  → ${p.migration}`
  );

  const message =
    `Database schema is behind this build — ${problems.length} problem(s):\n` +
    lines.join("\n") +
    `\n\nApply the outstanding migrations, then start again:\n` +
    `    psql "$DATABASE_URL" -f migrations/<file>.sql\n` +
    `  or:  npm run db:push\n\n` +
    `Starting anyway would leave features silently broken: analytics workers ` +
    `would fail to start, and the errors would not mention the schema.`;

  if (process.env.ALLOW_SCHEMA_DRIFT === "true") {
    console.warn(`⚠ ${message}\n\n(Continuing because ALLOW_SCHEMA_DRIFT=true.)`);
    return;
  }

  console.error(`❌ ${message}`);
  throw new Error("Database schema is out of date — refusing to start. See the log above.");
}
