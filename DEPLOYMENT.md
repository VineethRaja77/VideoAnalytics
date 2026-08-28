# Deployment — production checklist

## Required environment (boot fails without these)

```bash
DATABASE_URL=postgres://...
SESSION_SECRET=$(openssl rand -base64 32)        # already enforced
SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32) # NEW — camera credential encryption
```

**`SECRET_ENCRYPTION_KEY` must be backed up separately from the database.** It
encrypts every camera's RTSP URL and password. Lose it and those credentials are
unrecoverable — you would re-enter every camera by hand. It is deliberately not
derived from `SESSION_SECRET`, so rotating sessions cannot break camera access.

Without it the server still boots, logs a warning, and stores credentials in
plaintext. Do not ship that way.

## First-boot admin passwords

There are no default passwords any more. In `NODE_ENV=production` the server
**refuses to start** unless you set the relevant one:

```bash
SUPER_ADMIN_PASSWORD=...      # DEPLOYMENT_MODE=cloud  (min 12 chars)
ONPREM_ADMIN_PASSWORD=...     # DEPLOYMENT_MODE=onprem (min 12 chars)
```

Outside production a random password is generated and printed once at boot.

## Analytics workers

```bash
ANALYTICS_INGEST_KEY=<per-org token>
MODELS_BASE=/opt/vms/models       # optional, defaults to ./models
SNAPSHOT_RETENTION_DAYS=30        # 0 = keep forever
```

Mint a per-organisation token (super admin):

```
POST /api/admin/organizations/:id/ingest-token
```

Returned **once** — only its SHA-256 is stored. Set it as `ANALYTICS_INGEST_KEY`
on that client's box. Because the hash identifies exactly one tenant, a token
stolen from one site cannot post events for another. Re-issuing rotates and
immediately revokes the old token.

The legacy platform-wide key still authenticates but does **not** scope to a
tenant. Use per-org tokens for on-prem.

## Model artifacts

```bash
npx tsx server/modelRegistry.ts --record   # after deploying weights
npx tsx server/modelRegistry.ts            # verify
```

Writes/checks `models/manifest.json` (SHA-256 per weight file). Ship the manifest
with the release. The supervisor **refuses to start a worker whose weights are
missing or fail their checksum** — wrong weights produce plausible but incorrect
detections, which is worse than not running. Status: `GET /api/admin/models/status`.

## Migration

```bash
psql "$DATABASE_URL" -f migrations/0004_analytics_workers_and_encryption.sql
# or: npm run db:push
```

Camera credential encryption needs no schema change — `backfillCameraEncryption()`
rewrites plaintext rows in place at boot, and is idempotent.

## Enabling a model on a camera

```
POST /api/cameras/:cameraId/analytics   { "module": "vehicle", "config": { "COUNT_LINE": "0,620,1280,620" } }
GET  /api/analytics/bindings            org-wide status
PATCH /api/analytics/bindings/:id       { "enabled": false }
POST /api/analytics/bindings/:id/restart
```

`config` keys become environment variables for that worker, so every setting in
a module's `config.py` is overridable per camera.

Licence is enforced **twice**: at the route, and again in the supervisor before
each spawn. Enabling a binding directly in the database cannot start an
unlicensed worker.

## How client entitlements work

- `products` = the licensable modules (`vms`, `ppe`, `vehicle`, `face`)
- `licenses` = one row per (organisation, product) with plan, status, expiry, limits
- Client A licensed for 1 module and client B for 3 is just three licence rows

A licence that expires or is suspended **stops running workers within ~60 s** —
the supervisor re-checks on a timer, so revocation takes effect on the box, not
only in the UI.

## Security posture

| Control | Status |
|---|---|
| Camera credentials at rest | AES-256-GCM, key outside the DB |
| Worker→platform auth | Per-org token, SHA-256 stored, tenant-scoped |
| Session cookies | httpOnly, secure in production, sameSite lax, 12 h |
| Passwords | bcrypt cost 12 |
| Login brute force | 10 attempts / 15 min per IP+identifier |
| Ingest flood | 600/min per IP+token |
| API | 300/min |
| Headers | helmet (CSP off — it breaks WHEP/HLS media) |
| Tenant isolation | `resolveOrgScope` choke point; cross-tenant reads 404, not 403 |
| Snapshots | Authenticated, org-scoped, path-confined, auto-purged |
| On-prem licence | Ed25519 signed, machine-bound, public key only on the box |

## Tests

```bash
./run-tests.sh        # everything
npm test              # platform only (vitest)
```

60 tests across three suites, covering the invariants whose failure would be
silent in production:

| Suite | Covers |
|---|---|
| `server/__tests__/crypto.test.ts` | encryption round-trip, no plaintext leak, idempotency, fresh IV, legacy passthrough, GCM tamper detection, token one-wayness |
| `server/__tests__/rbac.test.ts` | tenant isolation (a client cannot target another org), role ranking, licence expiry evaluated live |
| `models/vehicle/tests/` | per-track voting, occlusion grace, counting-line single-fire, `counted` map bounded |
| `models/face/tests/` | **stranger → unknown**, margin guard on ambiguous matches, per-person scoring, gallery persistence |

Most of these are regression tests for bugs that were actually found. Two worth
knowing about:

- `test_grace_period_preserves_votes_through_occlusion` — purging track state on
  a single missed frame reset the class vote constantly (73 phantom tracks from
  39 real ids; lock rate stuck at 33%).
- `test_ambiguous_track_never_locks` — **found by writing the test**: at
  `lock_frames=5` a 3-vs-2 split hit exactly the old 0.6 share and froze a class.
  Lock share raised to 0.75 in both the vehicle and face voters.

## Still open

- **Vehicle**: `vehicle_profile.json` not generated (Kaggle hit its 12 h wall);
  running on BMD-45-derived defaults. Night/IR untested — training data is
  daytime only.
- **Face**: match threshold not tuned against real people + strangers; needs
  cameras giving 80+ px interocular (current site footage is 8–11 px); AuraFace
  provenance unconfirmed by fal; no liveness/anti-spoofing.
- **ANPR and vehicle colour**: not built.
- **No automated test suite.**
