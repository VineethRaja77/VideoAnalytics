# `shared/` — the contract between the two halves

[← back to the root README](../README.md) · siblings: [server/](../server/README.md) · [client/](../client/README.md) · [migrations/](../migrations/README.md)

One file, [`schema.ts`](schema.ts), imported by the server as `@shared/schema`
and by the browser bundle as `@shared/schema`. It holds three things:

1. **Drizzle table definitions** — the PostgreSQL schema, in TypeScript.
2. **Zod insert validators** (`createInsertSchema`) — so a route and a form
   validate against the same rules.
3. **The module/feature catalogue** — the constant the licensing model, the
   analytics supervisor and the admin console all read.

Nothing here executes at runtime beyond building those objects. It is the
single place where "what a camera is" is defined for both halves, which is why
a schema change here without a matching [migration](../migrations/README.md)
is caught at boot by [`schemaCheck.ts`](../server/schemaCheck.ts) rather than
becoming a mystery three days later.

---

## `MODULE_FEATURES` — the constant the licensing model rests on

```ts
module  = the runtime process that must be spawned   ("person")
feature = the thing a client actually buys           ("intrusion")
```

They used to be the same, which meant licensing `person` handed a client all
seven of its analytics. A client paying only for intrusion must not receive
loitering, crowd density and the rest.

One module serves many features because they share a detector and a tracker:
seven processes per camera for seven person analytics would compute the same
boxes seven times.

Derived from it, in the same file:

| Export | What it is |
|---|---|
| `ANALYTICS_MODULES` | the keys — `ppe` `face` `vehicle` `person` `tamper` `object` `sensors` |
| `ANALYTICS_FEATURES` | the flattened values, used as the Zod enum for a binding |
| `FEATURE_MODULE` | feature → the module whose worker provides it; the supervisor groups bindings with this |
| `FEATURE_LABELS` | human labels for the admin console and licence rows |

`sensors` is in this table deliberately even though it has no camera, no RTSP
and no GPU — listing it means the *same* licensing, org-scoping and entitlement
machinery covers it, and a client buying only `fuel_monitoring` gets exactly
that.

---

## Tables

### Tenancy and identity

| Table | Notes |
|---|---|
| `organizations` | one tenant and the central customer account. Holds `logoDataUrl` for organization branding. `ingestKeyHash` is the **SHA-256 of that org's analytics ingest token** — only the hash is stored, and it is scoped to one org, so a token leaked from one on-prem site cannot forge events for another tenant the way a platform-wide shared key could. The token is high-entropy random, so a fast hash is correct here; this is not a user password |
| `users` | `ROLES = super_admin | client_admin | client_manager | client_employee`. A `super_admin` has `organizationId = null` |
| `products` | licensable base products and feature products. Retired legacy products are kept for audit/history but hidden from grant flows |
| `licenses` | one row per (org, product), uniquely indexed. `plan`, `status`, `expiresAt`, `limits` JSON, plus the on-prem cryptographic columns `machineFingerprint`, `signedLicense`, `lastValidatedAt` |

### Video

| Table | Notes |
|---|---|
| `cameras` | connection details (`streamUrl`, `username`, **`password` stored AES-256-GCM encrypted** by [`crypto.ts`](../server/crypto.ts)), `videoCodec`, and the runtime columns owned by the recorder: `mediamtxPath`, `recordingPid`, `recordingFolder`, `lastStartedAt`, `lastHealthCheckAt`. `organizationId` is nullable **at the DB layer only**, for zero-downtime migration — application logic treats it as required |
| `recordings` | one row per finished segment: `filePath`, `startTime`/`endTime`, `duration`, `fileSize` |

### Analytics

| Table | Notes |
|---|---|
| `camera_analytics` | the **binding**: this camera runs this feature with this `config` JSON. Unique on `(cameraId, feature)` — a camera can carry several features of one module and they share a process. `module` is derived from `FEATURE_MODULE` but **stored**, so the watchdog does not re-derive it on every tick. Runtime columns (`status`, `pid`, `restartCount`, `lastError`, `lastStartedAt`, `lastHeartbeatAt`) are owned by the supervisor exactly as the recorder owns its columns on `cameras`. `status ∈ stopped \| starting \| running \| crashed \| unlicensed` |
| `analytics_events` | what workers POST: `module`, `type`, `trackId`, `details` JSON, `snapshot` path, `acknowledged`. Org-scoped, so client admins see only their own |

### Audit

`audit_log` is append-only — **no update or delete path exists in the
application**. It is required, not optional: the face module processes biometric
data, which is sensitive personal data under India's DPDP Act 2023, and a Data
Fiduciary must be able to show who accessed it. It also answers the question
every client eventually asks: *who watched that footage?*

Four constraints make it trustworthy:

- written **after** the action succeeds, so it never claims something that did
  not happen — except explicit `denied` outcomes, which record attempts;
- org-scoped like everything else;
- actor identity is duplicated into plain columns (`actorUsername`,
  `actorRole`), so the trail survives user deletion;
- **never stores the value of a secret**, only that a secret changed.

Indexed on `(organizationId, createdAt)`, `actorId`, and `action`.

### Platform settings

`platform_settings` is a small key/value table for deployment-owned UI settings,
currently platform branding (`platformLogoDataUrl`). Organization branding lives
on `organizations.logoDataUrl`.
`AUDIT_ACTIONS` enumerates every recordable action, from `login_failed` to
`recording_exported` to `ingest_token_minted`.

### Locations

`group → site → building → floor → zone`, arbitrary depth, as an **adjacency
list (`parentId`) plus a materialised path**. Not fixed columns per level,
because:

- fixed columns cannot express a campus with two towers and a basement car park,
  and every new level would be a migration;
- the path makes "everything under this node" one indexed prefix scan instead of
  a recursive query per dashboard refresh.

The path is built from **IDs, never names**, so renaming a building does not
rewrite its subtree. `LOCATION_KINDS` is advisory — it labels levels in the UI;
the tree itself accepts any depth. Cameras and devices keep their old free-text
location fields so an existing install keeps working before anything is
assigned.

### Sensors

| Table | Notes |
|---|---|
| `devices` | `externalId` (used in MQTT topics, unique per org), `kind`, `feature`, `config` JSON (tank geometry, Modbus register map). **`heartbeatSeconds`** — seconds after which silence means `unknown`, never "vacant" or "full". **`calibrationIntervalDays` / `calibratedAt`** — a pH electrode drifts and then reports confidently wrong numbers, so a probe past due is flagged rather than trusted; `NULL` interval means no calibration required |
| `sensor_readings` | `metric` (from `SENSOR_METRICS`: `distance_mm`, `level_pct`, `ph`, `tds_ppm`, `flow_lpm`, `energy_kwh`, `state`, …), `value`, `unit`, and **`quality ∈ good \| suspect \| stale`** so a dashboard can show an uncalibrated reading without implying it is trusted. Indexed on `(deviceId, at)` and `(organizationId, at)` |
| `sensor_rules` | threshold rules. `forSeconds` is the **debounce**: a tank sloshing across the limit for one reading is not a low-fuel event, and without it an operator gets alert-flapping and stops reading alerts entirely |

---

## Changing the schema

```bash
# 1. edit shared/schema.ts
npm run db:push          # dev: push straight to the database
# 2. for anything shipped, add a numbered SQL file in migrations/
npm run check            # tsc — both halves compile against the change
```

`schemaCheck.ts` asserts at boot that the live database actually has the shape
this build expects, and names the migration that creates anything missing.
Adding a table here without adding it there means an install can start, look
fine, and silently fail days later.
