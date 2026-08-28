# `server/` — the Node platform

[← back to the root README](../README.md) · siblings: [client/](../client/README.md) · [shared/](../shared/README.md) · [models/](../models/README.md) · [deploy/](../deploy/README.md)

One Express process runs the entire site: HTTP API, session auth, RBAC and
tenant isolation, licensing, the MediaMTX control plane, the GStreamer recorder
supervisor, the Python analytics supervisor, sensor ingestion, and disk
monitoring. It is a single process on purpose — at 300–1000 cameras the
supervision logic needs to sit next to the database and the MediaMTX calls it
reacts to.

There is **no video pixel data in this process**. Node never decodes a frame.
It tells MediaMTX which cameras to pull, spawns GStreamer and Python children
that read from MediaMTX, and stores what they report.

---

## Boot order — and why it is exactly this

[`index.ts`](index.ts) is short, and every line of it is ordered deliberately:

```
trust proxy 1                 nginx terminates TLS; without this, secure
                              cookies never set in production
applySecurityHeaders()        helmet, before anything reads input
apiLimiter                    rate limit, before anything reads input
setupSession()                must precede any route touching req.session
requireSameOrigin on /api     CSRF: after session (so it protects cookie auth),
                              before any handler that mutates
/whep, /hls-live proxies      MediaMTX passthrough — one origin for the browser
express.json({verify})        raw body captured for signature checks
──────── async ────────
assertConfigUsable()          fatal misconfig (default admin password in prod)
assertSchemaCurrent()         schema drift → refuse to boot, name the migration
initLicensing()               cloud: load/generate keypair. onprem: verify .lic
seedPlatform()                idempotent: super_admin or org+admin+licence
registerRoutes()              everything else, incl. starting the supervisors
global error handler
setupVite() / serveStatic()   LAST — dev integration imported dynamically so
                              it never enters the bytecode production bundle
listen(:5002)
```

`assertSchemaCurrent` exists because of a real incident: migrations 0004/0005
were never applied on a dev box, and the symptoms were a crash during seeding
and "Failed to restore analytics workers" — neither of which mentions the
schema. Tests could not catch it because they build their own schema. So the
check is explicit, runs before anything touches the DB, and names the exact
missing object and the migration that creates it.

---

## The media plane

### MediaMTX is the only thing that talks to a camera

[`mediamtxController.ts`](mediamtxController.ts) owns MediaMTX path lifecycle
over its HTTP Control API (`:9997`).

```
addOrUpdateCameraPath(camera)   → MediaMTX pulls rtsp://<camera> as cam_<id>
mediamtxPathForCamera(id)       → "cam_<id>"
transcodePathForCamera(id)      → "cam_<id>_h264"
waitForPathReady(path, …)       → poll until the source is actually up
```

Every consumer then reads `rtsp://127.0.0.1:8554/cam_<id>`. One camera, one
pull, N local readers. This is why enabling a fifth analytic costs the camera
nothing.

### The H.265 problem, and the on-demand transcode

Many cameras emit H.265. WebRTC H.265 support is a mess: Firefox and Edge do not
implement it, Chrome only on Windows with a capable GPU, Safari 18+ does.

The client decides **before opening a connection**, with a zero-network-cost
`canPlayType`/codec probe ([`client/src/lib/codecCapability.ts`](../client/src/lib/codecCapability.ts)) — never by
trial and error. If the browser cannot decode it, `GET /api/webrtc-config/:cameraId`
hands back the `cam_<id>_h264` path instead, and `ensureTranscodePath()` registers
a MediaMTX `runOnDemand` entry whose command is a GStreamer H.265→H.264
transcode. It only runs while someone is watching, and it picks a hardware
decoder when one exists:

| GPU | Pipeline fragment |
|---|---|
| NVIDIA | `nvh265dec ! nvh264enc preset=low-latency-hq bitrate=2000` |
| Intel/AMD VA-API | `vah265dec ! vah264enc` |
| none | software fallback |

Detection lives in [`gstCapabilities.ts`](gstCapabilities.ts).

### Recording — [`recordingWorker.ts`](recordingWorker.ts)

One GStreamer child process per recording camera, consuming MediaMTX's RTSP and
**stream-copying** (no re-encode) into segmented MP4s. Node supervises them
directly rather than generating systemd units, because at 300–1000 cameras that
would mean 300–1000 unit files and no way to express staggered startup,
backoff+jitter, or a stall watchdog — `Restart=` has no concept of any of that.

| Control | Value | Why |
|---|---|---|
| `STARTUP_STAGGER_MS` | 250 | 500 recorders starting at once is a thundering herd against MediaMTX |
| `BASE_BACKOFF_MS` → `MAX_BACKOFF_MS` | 2s → 120s, jittered | jitter prevents synchronised retry storms after a network blip |
| `STALL_WINDOW_MS` | 90s | a GStreamer process can stay *alive* while writing nothing; liveness ≠ health |
| `WATCHDOG_INTERVAL_MS` | 15s | how often stalls are checked |

Backoff resets when a **segment is actually written** — proof of health, not
mere uptime. A `chokidar` watcher on the recording folder is what notices new
segments; it also drives the DB rows for playback.

Two post-processing steps run on finished segments:

- **`remuxToFaststart`** — moves the MP4 `moov` atom to the front. Without it a
  browser must download the whole file before it can start playing.
- **`ensureH264Variant`** — for H.265 recordings, lazily produces an H.264
  sibling so a browser that cannot decode HEVC in a `<video>` element can still
  play back and export. (`browserSupportsH265File` is a *different* check from
  the WebRTC one — the two decode paths differ.)

`killOrphanedRecorders()` + `initRecordersFromDB()` run at boot: Node may have
crashed mid-recording, leaving GStreamer processes with no supervisor. State is
reconciled from the database, not assumed.

---

## The analytics plane — [`analyticsWorker.ts`](analyticsWorker.ts)

Same supervision skeleton as the recorder (stagger, backoff+jitter, watchdog)
plus two things recording does not need.

**1. Runtime licence enforcement, per feature.** Re-checked every 60s
(`LICENCE_RECHECK_MS`). Gating HTTP routes alone would leave an already-running
analytic untouched when a licence expires — so an expired licence *stops the
process on the box*.

**2. One process per (camera, module), not per feature.** Six person analytics
on one camera share a detector and a tracker. Six processes would compute the
same boxes six times. The supervisor groups `camera_analytics` rows by module
and passes the licensed feature names as `ENABLED_FEATURES` to a single worker.

```
GroupKey = `${cameraId}:${module}`

spawn  models/<module>/.venv/bin/python worker.py
env    SOURCE_RTSP=rtsp://127.0.0.1:8554/cam_<id>
       CAMERA_ID=<uuid>
       ENABLED_FEATURES=intrusion,loitering
       POST_EVENTS=true  PLATFORM_API=…  ANALYTICS_INGEST_KEY=…
       + the binding's `config` JSON, flattened to env vars
```

Health and failure:

| Constant | Value | Meaning |
|---|---|---|
| `HEALTHY_UPTIME_MS` | 120s | a worker up this long resets its backoff counter. Without it, ten crashes during an outage months ago pin the delay at 300s forever, so the next unrelated blip costs five minutes of lost analytics |
| `FAILING_ALERT_THRESHOLD` | 5 crashes | below this it is a blip and self-heals; at or above, a human must look (bad weights, unreachable camera, OOM). The admin is alerted **once**, not per crash |
| `MAX_BACKOFF_MS` | 300s | |

Before spawning, [`modelRegistry.ts`](modelRegistry.ts) verifies each required
artifact against a SHA-256 in `models/manifest.json`. Wrong weights produce
plausible-but-wrong detections, which is worse than not running. A module whose
venv is missing is **refused**, with a message to the client admin, rather than
restart-looped in silence.

Binding status values: `stopped | starting | running | crashed | unlicensed`.

### Events come back over one endpoint

`POST /api/analytics/events` ([`analyticsRoutes.ts`](analyticsRoutes.ts)),
authenticated with a per-org ingest key (`X-Ingest-Key`), hashed at rest as
`organizations.ingest_key_hash`. The worker never authenticates as a user and
never sees a session cookie. Snapshots are served separately and org-scoped by
[`snapshotRoutes.ts`](snapshotRoutes.ts).

---

## Security, identity and tenancy

| File | Responsibility |
|---|---|
| [`auth.ts`](auth.ts) | express-session on Postgres; **rolling idle timeout** plus an **absolute cap**. The absolute cap is the one that matters: without it a cookie copied off a device stays valid forever as long as something keeps using it |
| [`rbac.ts`](rbac.ts) | four roles; `resolveOrgScope` is the **single choke point** for tenant isolation — every org-scoped handler derives its org from it, never from the client |
| [`security.ts`](security.ts) | helmet headers, 10-attempts-per-IP-per-15-min login limiter, `requireSameOrigin` CSRF. Two deliberate carve-outs: **CSP off** and **COEP/CORP off**, because a wrong policy silently breaks live video on a single-origin app with no user-supplied HTML |
| [`crypto.ts`](crypto.ts) | AES-256-GCM envelope encryption for camera RTSP passwords, format `v1:<iv>:<tag>:<ct>`. Reversible by necessity — the recorder must replay the password to the camera. The key is **not** derived from `SESSION_SECRET`, or rotating a session secret would make every camera password undecryptable |
| [`audit.ts`](audit.ts) | append-only trail. Two absolute rules: auditing **never breaks the action it records** (a failed insert is logged and swallowed), and **no secrets ever reach the table** — `detail` is key-scrubbed at any nesting depth, keeping the key with `[redacted]` so "the password changed" is still auditable |

`resolveOrgScope` fails **closed**. So does the sensor layer, and so does PPE
visibility. That is the house style: absence of evidence is never evidence.

---

## Licensing

Four files, two deployment modes.

```
DEPLOYMENT_MODE=cloud    this box IS the authority. Holds the Ed25519 PRIVATE
                         key, signs tokens, answers phone-home checks.
DEPLOYMENT_MODE=onprem   this box is a CONSUMER. Ships with the PUBLIC key only.
                         It does NOT trust its own database for entitlement —
                         the client controls that database.
```

| File | Role |
|---|---|
| [`licenseCrypto.ts`](licenseCrypto.ts) | Ed25519 sign/verify. A token is a compact `payload.signature` string: tamper-proof, self-contained, machine-bound |
| [`machineId.ts`](machineId.ts) | hardware fingerprint from `/etc/machine-id` + primary MAC, hashed so no raw identifier leaks. `MACHINE_FINGERPRINT` overrides it for VMs/containers |
| [`licenseService.ts`](licenseService.ts) | cloud side: re-signs a token after every issue/patch so the downloadable `.lic` always matches current terms |
| [`licenseClient.ts`](licenseClient.ts) | on-prem side: offline verify (signature + machine binding + expiry), scheduled phone-home for suspend/revoke, and a **grace window** so a short outage does not disable a paid feature |
| [`entitlements.ts`](entitlements.ts) | the pure validity computation both paths share; expiry is evaluated live, not read from a stored status column |

---

## The non-video module: sensors

[`sensors.ts`](sensors.ts) + [`sensorRoutes.ts`](sensorRoutes.ts) +
[`sensorMqtt.ts`](sensorMqtt.ts) handle parking bays, tank levels, water
quality, fuel, energy meters and pump/DG status. No camera, no RTSP, no GPU — a
reading every 30–60s per device, stored and evaluated against threshold rules.
It lives in the main server because the whole workload is a few hundred rows a
minute, and it is listed in `MODULE_FEATURES` so the *same* licensing, org
scoping and entitlement machinery covers it.

Three rules, all learned from the camera side:

1. **Silence is its own state.** A sensor that stops reporting is `unknown`,
   never "vacant" and never "full". A dead bay sensor read as vacant sends
   drivers to a full level; a dead tank sensor read as full hides an empty tank.
2. **An uncalibrated probe is not trusted.** pH electrodes drift and then report
   confidently wrong numbers. Past its calibration interval a reading is stored
   but marked `suspect`, and rules do not fire on it.
3. **One ingest path.** MQTT messages are funnelled into the same
   `ingestReading()` the HTTP route uses — one set of rules, one place where
   tenant scoping is enforced.

MQTT topic contract: `vms/<orgIngestToken>/<deviceExternalId>/<metric>`. The
token sits in the topic because MQTT 3.1.1 has no per-message auth and cheap
gateways cannot set headers — which means **the broker must be on a private
network or TLS**. Prefer `POST /api/sensors/readings` where headers are
possible. A gateway publishing another org's device id gets "unknown device",
never a cross-tenant write. The bridge is inert unless `MQTT_URL` is set.

---

## Locations — [`locations.ts`](locations.ts)

`group → site → building → floor → zone`, any depth. Adjacency list (`parentId`)
plus a **materialised path**, so "every camera under Tower B" is one indexed
prefix scan rather than a recursive walk per dashboard refresh.

Four guarded failure modes:

1. **A cycle** — moving a building under its own floor makes every ancestor walk
   loop forever and takes the server down. Rejected before the write.
2. **A cross-tenant parent** — would place one client's cameras inside another's tree.
3. **A stale subtree path** — a move repaths every descendant in the *same*
   transaction, or "everything under Tower B" silently returns the wrong set.
4. **Silently orphaned cameras** — deleting a floor holding 40 cameras fails
   loudly rather than detaching them where nobody will look.

---

## Operational safety nets

- [`storageMonitor.ts`](storageMonitor.ts) — a VMS writes continuously and never
  stops. The first symptom of a full disk is *everything* failing at once with
  unrelated-looking errors, and nothing in that pile says "the disk is full".
  Two thresholds (warning / critical, with an absolute floor as well as a
  percentage), notifying every client admin whose cameras live on the box.
- [`events.ts`](events.ts) — in-memory notification log behind the UI bell.
  Deliberately not persisted: it is a "what's happening lately" surface, not an
  audit trail, and keeping it off the DB hot path matters when supervisors are
  chattering. **Tenant scoping is not optional here** — messages embed camera
  names ("Recording for *Gate 3 Loading Bay* stopped"), so a global list would
  disclose another client's site layout.
- [`storage.ts`](storage.ts) — the Drizzle data-access layer; every query that
  can be org-scoped is.
- [`seed.ts`](seed.ts) — idempotent boot seeding by mode. Ordinary seed failures
  are swallowed so a transient DB hiccup does not block startup; a *fatal*
  misconfiguration (default admin password in production) is a distinct type
  that cannot be swallowed with them.

---

## HTTP surface

Registered by [`routes.ts`](routes.ts), which mounts the per-area route modules.

| Area | File | Endpoints |
|---|---|---|
| Auth | `routes.ts` | `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` `POST /api/auth/change-password` |
| Cameras | `routes.ts` | `GET|POST /api/cameras` · `GET|PATCH|DELETE /api/cameras/:id` · `POST /api/cameras/test-connection` |
| Streams | `routes.ts` | `POST /api/streams/start|stop` · `GET /api/streams/status/:id` · `GET /api/webrtc-config/:cameraId` |
| Recordings | `routes.ts` | `GET /api/cameras/:id/recordings` · `GET /api/recordings/:cameraId/:filename` · `GET /api/export/:cameraId/:filename` |
| System | `routes.ts` | `GET /api/health` `GET /api/system/storage` `GET /api/audit` `GET /api/notifications` |
| Analytics events | [`analyticsRoutes.ts`](analyticsRoutes.ts) | `POST /api/analytics/events` (ingest key) · `GET /api/analytics/events` · `POST /api/analytics/events/:id/ack` |
| Analytics bindings | [`cameraAnalyticsRoutes.ts`](cameraAnalyticsRoutes.ts) | `GET|POST /api/cameras/:cameraId/analytics` · `GET /api/analytics/bindings` · `PATCH|DELETE /api/analytics/bindings/:id` · `POST /api/analytics/bindings/:id/restart` |
| Snapshots | [`snapshotRoutes.ts`](snapshotRoutes.ts) | `GET /api/analytics/events/:id/snapshot` |
| Locations | [`locationRoutes.ts`](locationRoutes.ts) | `GET /api/locations` · `/unassigned` · `/:id/breadcrumb` · `/:id/cameras` · `POST /api/locations` · `PATCH|DELETE /:id` · `POST /api/locations/assign` |
| Sensors | [`sensorRoutes.ts`](sensorRoutes.ts) | `POST /api/sensors/readings` · `GET /devices|/parking|/maintenance|/metrics` · `GET /devices/:id/history` · `POST /devices` · `POST /devices/:id/calibrate` |
| Org users | [`orgRoutes.ts`](orgRoutes.ts) | `GET|POST /api/org/users` · `PATCH|DELETE /api/org/users/:id` |
| Platform admin | [`adminRoutes.ts`](adminRoutes.ts) | organizations, users, products, licenses (incl. `GET /licenses/:id/file`), `GET /api/admin/models/status`, `POST /api/admin/organizations/:id/ingest-token` |
| Licence | [`licenseRoutes.ts`](licenseRoutes.ts) | `GET /api/license/fingerprint` · `POST /api/license/validate` |

---

## Tests — [`__tests__/`](__tests__/)

```bash
npm test          # vitest run
npm run test:watch
```

Eleven suites, each pinning a behaviour that would otherwise fail **silently**:

| Suite | Pins |
|---|---|
| `tenantIsolation.test.ts` | no handler can be tricked into another org's data |
| `rbac.test.ts` | role gates, including `resolveOrgScope` failing closed |
| `session.test.ts` | idle rolling *and* the absolute cap |
| `crypto.test.ts` | encrypt/decrypt round-trip and legacy-plaintext recognition |
| `audit.test.ts` | secret scrubbing at depth; a failed insert never breaks the action |
| `hardening.test.ts` | headers, rate limits, same-origin enforcement |
| `features.test.ts` | module↔feature mapping and licence gating |
| `notifications.test.ts` | events are org-scoped |
| `storageMonitor.test.ts` | both thresholds, including the absolute floor |
| `sensors.test.ts` | silence → `unknown`; stale calibration → `suspect` |
| `locations.test.ts` | cycles, cross-tenant parents, repathing, orphan refusal |

Tests build their own schema — which is exactly why `schemaCheck.ts` exists for
the real one.

---

## Gotchas

- **`vite.ts` must never be statically imported.** It uses top-level await and
  cannot be compiled to CommonJS/bytecode; `index.ts` imports it dynamically and
  only in development. Static serving lives in [`serve.ts`](serve.ts), which is
  Vite-free for the same reason.
- **`trust proxy` is load-bearing.** Without it `cookie.secure` never sets
  behind nginx, and every production login silently fails.
- **`/whep` path rewriting is asymmetric.** The browser convention is
  `/whep/{path}`; MediaMTX wants `/{path}/whep`.
- **Ingest keys are not sessions.** Analytics workers authenticate with
  `X-Ingest-Key` only, and that key is org-scoped.
