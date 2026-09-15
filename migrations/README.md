# `migrations/` — database schema history

[← back to the root README](../README.md) · siblings: [shared/](../shared/README.md) · [server/](../server/README.md) · [scripts/](../scripts/README.md)

Numbered SQL files, applied in order. The authoritative *shape* of the database
is [`shared/schema.ts`](../shared/schema.ts); these files are how a database
that already exists gets there.

`meta/` holds drizzle-kit's snapshots and `_journal.json`. It is generated —
do not hand-edit it.

---

## Two paths, and when each is right

```bash
npm run db:push     # drizzle-kit push: diff schema.ts against the live DB and
                    # apply. Fast, destructive-capable, DEVELOPMENT ONLY.

psql … -f migrations/00NN_*.sql    # explicit, reviewable, ordered.
                                   # Anything shipped to a client goes here.
```

`db:push` cannot express a data transformation. Migration 0003 is the standing
example: the `password → password_hash` change is **not a plain rename** — every
existing row needs its value re-derived, and a push would have silently produced
a column full of unusable plaintext. Anything that touches existing rows needs a
hand-written file.

---

## The history, and what each migration was for

| File | Change | Why it exists |
|---|---|---|
| `0000_last_surge.sql` | initial `cameras`, users, core tables | the original schema |
| `0001_yummy_outlaw_kid.sql` | `cameras.ip_address`, `vendor`, `port` | ONVIF discovery details |
| `0002_perfect_scarlet_spider.sql` | `stream_mode`, `is_streaming`, `last_stream_pid`, `hls_path`, `recording_folder`, `last_started_at` | the pre-MediaMTX streaming model |
| `0003_gstreamer_mediamtx_rewrite.sql` | MediaMTX + GStreamer rewrite; `password` → `password_hash` | replaced ad-hoc ffmpeg spawning. **Needs a data step**, not a rename — see above |
| `0004_analytics_workers_and_encryption.sql` | `camera_analytics`; `organizations.ingest_key_hash`; `analytics_events.snapshot`/`acknowledged`; encrypted camera credentials | AI worker orchestration and per-tenant worker auth |
| `0005_analytics_features.sql` | `camera_analytics.feature` + `.module`; unique on `(camera, feature)` | **licence per feature, not per module.** Before this, licensing `vehicle` gave a client every vehicle analytic, and `person` would have handed over all seven at once |
| `0006_audit_log.sql` | `audit_log` + its three indexes | DPDP Act 2023: the face module processes biometric data and a Data Fiduciary must show who accessed it |
| `0007_sensors.sql` | `devices`, `sensor_readings`, `sensor_rules` | **one generic model, not a table per sensor type** — adding "water pH" after shipping must not be a migration |
| `0008_locations.sql` | `locations` with `parent_id`, `path`, `depth`; `location_id` on cameras and devices | fixed site/building/floor columns cannot express a campus with two towers and a basement car park |
| `0009_timestamps_are_instants.sql` | normalises timestamp semantics for event/schedule correctness | browser, server and workers must agree on site-time windows without shifting days across time zones |
| `0010_branding.sql` | `organizations.logo_data_url` and `platform_settings` | organization and platform branding are first-class settings, not hard-coded UI text |

---

## Drift is checked at boot, not discovered later

[`server/schemaCheck.ts`](../server/schemaCheck.ts) holds an explicit list of
`{ table, columns, migration }` and refuses to start when something is missing —
naming the migration that creates it.

This exists because of a real incident: 0004 and 0005 were never applied on a
development box. The symptoms were a crash during seeding and *"Failed to
restore analytics workers"* — neither of which mentions the schema. The test
suite passed throughout, because tests build their own schema and therefore
cannot see drift in the real one.

On a client site it is worse: the installer runs the app, some pages work,
analytics silently never start, and the fault surfaces days later as *"the AI
features don't do anything"*.

**So: if you add a table or column in `shared/schema.ts`, add it to
`REQUIRED_SCHEMA` in `schemaCheck.ts` in the same commit as the migration.**

---

## Adding a migration

1. Edit [`shared/schema.ts`](../shared/schema.ts).
2. `npm run db:push` locally to iterate.
3. Write `migrations/00NN_short_name.sql` with a header comment saying **what it
   adds and why** — every file here has one, and they are the reason the history
   above could be written.
4. Add the new table/columns to `REQUIRED_SCHEMA` in `schemaCheck.ts`.
5. `npm run check` and `npm test`.

Never renumber or edit a migration that has shipped.
