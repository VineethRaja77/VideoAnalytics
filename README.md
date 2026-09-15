# Hyperspark VMS

A multi-tenant Video Management System: IP cameras in, live video and AI events
out. One Node/Express platform owns cameras, streaming, recording, users,
licensing and the database. A set of independent Python workers does the
computer vision. The two halves talk over RTSP (video in) and one HTTP endpoint
(events out), and nothing else.

This file is the **map**. It carries the architecture, the vocabulary and the
quick start, and then hands off — every directory below has its own README with
the depth. Read this once, then read the one for the part you are touching.

---

## The whole system in one picture

```
                    ┌──────────────┐
   IP camera ──────▶│              │─── WebRTC (WHEP) ──▶ browser, live
   (RTSP, ONVIF)    │   MediaMTX   │─── LL-HLS ─────────▶ browser, fallback
                    │              │
                    │ pulls each   │─── RTSP (localhost) ─▶ GStreamer ─▶ .mp4 segments
                    │ camera ONCE  │                        (recordingWorker)
                    │              │
                    │              │─── RTSP (localhost) ─▶ Python analytics worker
                    └──────────────┘                        (analyticsWorker)
                           ▲                                        │
                           │ Control API (:9997)                    │ POST /api/analytics/events
                           │                                        ▼
                    ┌──────┴──────────────────────────────────────────────┐
                    │  Node / Express platform  (server/)                  │
                    │  auth · RBAC · tenancy · licensing · recording       │
                    │  supervision · analytics supervision · sensors       │
                    └──────┬──────────────────────────────────────────────┘
                           │  Drizzle ORM
                    ┌──────▼──────┐        ┌──────────────────────────────┐
                    │  PostgreSQL │        │  React SPA (client/)          │
                    └─────────────┘        │  live grid · playback ·       │
                                           │  events · admin console       │
                                           └──────────────────────────────┘
```

**The rule that shapes everything:** a camera is pulled exactly **once**, by
MediaMTX. The recorder and every analytics worker read MediaMTX's re-published
local RTSP (`rtsp://127.0.0.1:8554/cam_<id>`), never the camera itself. Adding a
fifth analytic to a camera therefore adds zero load on that camera.

---

## Two planes, deliberately separate

| | Node platform (`server/`) | Python analytics (`models/`) |
|---|---|---|
| Language | TypeScript on Node 20 | Python 3.12, one venv **per module** |
| Owns | cameras, users, orgs, licences, recordings, sensors, the DB | detection, tracking, rules, events |
| Talks to | Postgres, MediaMTX Control API, GStreamer, the browser | one RTSP URL in, one HTTP POST out |
| Scale unit | one process for the whole site | one process per **(camera, module)** |
| Deps | see [package.json](package.json) | onnxruntime + OpenCV + numpy (no torch at runtime) |

They are separate because CV inference is a Python world and because a client
who licensed only vehicle counting should not have PPE's dependency tree on
disk. `scripts/install-models.sh` builds each module's venv independently.

---

## Repository map

### Platform

| Directory | What lives there | README |
|---|---|---|
| [server/](server/) | Express app: routes, auth, RBAC, tenancy, licensing, recorder + analytics supervisors, sensors, storage | [server/README.md](server/README.md) |
| [client/](client/) | React 18 + Vite SPA: live grid, WHEP player, playback, event views, admin console | [client/README.md](client/README.md) |
| [shared/](shared/) | Drizzle schema + Zod validators + the module/feature catalogue — the contract both halves import | [shared/README.md](shared/README.md) |
| [migrations/](migrations/) | Numbered SQL migrations and Drizzle metadata | [migrations/README.md](migrations/README.md) |
| [scripts/](scripts/) | Operational scripts: venv installer, protected build, backup/restore, e2e camera check | [scripts/README.md](scripts/README.md) |
| [deploy/](deploy/) | systemd units, MediaMTX config, nginx site, env template, on-prem install guide | [deploy/README.md](deploy/README.md) |

### Analytics

| Directory | What it detects | Model | README |
|---|---|---|---|
| [models/](models/) | — the analytics hub: worker contract, event schema, supervision | — | [models/README.md](models/README.md) |
| [models/ppe/](models/ppe/) | helmet / vest / gloves / boots compliance | RF-DETR-S, 9 classes, trained | [models/ppe/README.md](models/ppe/README.md) |
| [models/vehicle/](models/vehicle/) | 8 vehicle classes, counting, wrong-way, parking, congestion | RF-DETR-S, trained on BMD-45 | [models/vehicle/README.md](models/vehicle/README.md) |
| [models/person/](models/person/) | intrusion, footfall, loitering, crowd, queue, tailgating, fall | RF-DETR-S COCO, **untrained** | [models/person/README.md](models/person/README.md) |
| [models/face/](models/face/) | face recognition against an enrolled gallery | YuNet + AuraFace, **frozen** | [models/face/README.md](models/face/README.md) |
| [models/object/](models/object/) | object left behind / removed | **no model** — dual background subtraction | [models/object/README.md](models/object/README.md) |
| [models/tamper/](models/tamper/) | lens blocked, defocused, camera moved, feed frozen | **no model** — image statistics | [models/tamper/README.md](models/tamper/README.md) |

### Training

| Directory | Trains | README |
|---|---|---|
| [train/](train/) | the PPE + person detector, plus the CVAT labelling pipeline | [train/README.md](train/README.md) |
| [train_vehicle/](train_vehicle/) | the 8-class vehicle detector on BMD-45 | [train_vehicle/README.md](train_vehicle/README.md) |
| [train_fire/](train_fire/) | fire + smoke (2 classes) — trainer written, worker not built | [train_fire/README.md](train_fire/README.md) |
| [data/](data/) | local datasets and test footage (git-ignored, multi-GB) | [data/README.md](data/README.md) |

Not documented, because they are generated or vendored: `node_modules/`,
`dist/`, `runs/`, `outputs/`, `train_weights/`, `attached_assets/`.

---

## Vocabulary you need before reading anything else

**Module vs feature.** A *module* is a worker process (`person`). A *feature* is
the thing a client buys (`intrusion`). One module serves many features because
they share a detector and a tracker — running seven person analytics as seven
processes would compute the same boxes seven times. The mapping lives in one
place, [`MODULE_FEATURES`](shared/schema.ts), and both the licensing code and
the supervisor read it.

| Module | Features |
|---|---|
| `ppe` | `ppe_compliance` |
| `face` | `face_recognition` |
| `vehicle` | `vehicle_count` `wrong_way` `illegal_parking` `congestion` `triple_riding` |
| `person` | `intrusion` `people_count` `loitering` `crowd_density` `queue_dwell` `tailgating` `fall` |
| `tamper` | `camera_tamper` |
| `object` | `object_left` `object_removed` |
| `sensors` | `bay_occupancy` `tank_level` `water_quality` `fuel_monitoring` `energy_metering` `leak_detection` `equipment_status` |

**Binding.** A row in `camera_analytics` — "this camera runs this feature, with
this config". The supervisor groups a camera's bindings by module and starts
**one process per (camera, module)**, passing the licensed feature names as
`ENABLED_FEATURES`. An unlicensed rule is never constructed; it does not exist
at runtime.

**Licence, enforced twice.** HTTP routes are gated by
[`entitlements.ts`](server/entitlements.ts), and running workers are re-checked
on a 60-second timer by [`analyticsWorker.ts`](server/analyticsWorker.ts).
Gating routes alone would leave an already-running analytic untouched when a
licence expires. On-prem installs verify an Ed25519-signed, machine-bound
licence file offline and phone home for suspend/revoke.

**Tenancy.** Every org-scoped handler derives its organisation from
`resolveOrgScope` in [`rbac.ts`](server/rbac.ts) — never from the request body.
Four roles: `super_admin`, `client_admin`, `client_manager`, `client_employee`.


## Product surfaces

**Super Admin console.** The platform owner works at the organization level:
Overview, Organizations, Licensing, Models, System, Audit and Settings. Creating
an organization is a single wizard (organization identity/logo, administrator,
feature entitlements, limits, review) so the organization, its primary admin,
licences and allowances are provisioned atomically. Platform Licensing shows one
contract row per organization and opens into feature-level entitlements.

**Client portal.** Organization users own their daily operations: Operations,
Live, Cameras, Playback, Analytics Setup, Events, Users, Audit Trail and
Settings. Events are consolidated into an Events Center with module tabs gated
by licensed features. Sites, cameras, staff, sensors, operational analytics and
events stay in the client portal; Super Admin sees aggregate usage and platform
health.

---

## Quick start (development)

```bash
# 1. Postgres + env
cp deploy/vms.env.example .env        # set DATABASE_URL, SESSION_SECRET,
                                      # SECRET_ENCRYPTION_KEY, DEPLOYMENT_MODE
npm install
npm run db:push                       # apply the Drizzle schema

# 2. MediaMTX must be running for any live video
mediamtx deploy/mediamtx.yml

# 3. The app
npm run dev                           # http://localhost:5002

# 4. Analytics (only if you want AI features)
./scripts/install-models.sh           # builds models/<module>/.venv for each
#   then copy the .onnx weights into models/<module>/weights/
npx tsx server/modelRegistry.ts --record   # pin their checksums
```

Boot is intentionally loud: [`schemaCheck.ts`](server/schemaCheck.ts) refuses to
start on schema drift and names the missing object *and* the migration that
creates it, because the symptoms of drift (a seeding crash, "failed to restore
analytics workers") never mention the schema.

| Command | Does |
|---|---|
| `npm run dev` | tsx + Vite middleware, hot reload |
| `npm run build` | Vite → `dist/public`, esbuild → `dist/index.js` |
| `npm run build:protected` | bytecode build for on-prem — see [deploy/PROTECTED-BUILD.md](deploy/PROTECTED-BUILD.md) |
| `npm run check` | `tsc`, no emit |
| `npm test` | Vitest server suite (currently 20 files) in [server/__tests__/](server/__tests__/) |
| `npm run db:push` | drizzle-kit push |

Production install, TLS, firewall and systemd: **[deploy/README.md](deploy/README.md)**.
Environment variables and the go-live checklist: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Licensing of what we ship (not client licences — software licences)

This constrained real architecture decisions, so it belongs in the overview.

Ultralytics YOLO is **AGPL-3.0**, and its licence covers "the training code and
the models produced by that training code". Distributing it would entitle every
client to the complete source of the whole VMS. Every runtime model was
therefore moved off YOLO:

| Component | Licence | Where |
|---|---|---|
| RF-DETR **Nano/Small/Medium/Large** + DINOv2 backbone | Apache-2.0 | all detection modules |
| RF-DETR **XLarge / 2XLarge** | PML-1.0 — **never use** | — |
| `onnxruntime` | MIT | all inference |
| `supervision` (ByteTrack) | MIT | all tracking |
| YuNet (OpenCV Zoo) | MIT | face detection |
| AuraFace `glintr100` | Apache-2.0 (provenance unconfirmed — see [models/face/](models/face/README.md)) | face embedding |
| BMD-45 dataset | CC BY 4.0 — attribution required | vehicle model |

Attribution obligations are discharged by [NOTICE](NOTICE), which ships with the
product. The training scripts under `train*/` still use Ultralytics in places;
that is fine for internal experiments and is why the RF-DETR variants exist
alongside them.

---

## Conventions

- **Docs live next to code.** Every significant directory has a README; this one
  only indexes them. If you change behaviour, change the README in that
  directory in the same commit.
- **Comments carry the *why*.** Most files here open with a block explaining the
  failure that motivated the design. Read it before changing the code under it.
- **Fail closed and loudly.** A sensor that stops reporting is `unknown`, never
  "vacant". A PPE item that cannot be seen is `unknown`, never "missing". A
  worker with no venv refuses to spawn rather than restart-looping in silence.
- **Track ids are within-session handles.** ByteTrack reissues them and restarts
  numbering on every process start. Never persist one as a database key.

---

## Other documents at the root

| File | What it is |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Required env vars, first-boot passwords, entitlements, security posture, go-live checklist |
| [NOTICE](NOTICE) | Third-party dataset attributions that must ship with the product |
| [design_guidelines.md](design_guidelines.md) | Colour system, typography, layout rules for the UI |
| [replit.md](replit.md) | Historical — the original Replit-era architecture note. Superseded by this file; parts of it (e.g. "in-memory storage") no longer describe the system |
