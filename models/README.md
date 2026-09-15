# `models/` — the analytics workers

[← back to the root README](../README.md) · siblings: [server/](../server/README.md) · [train/](../train/README.md) · [deploy/](../deploy/README.md)

Six standalone Python workers. Each is independent of the Node platform, has
its own virtualenv and its own pinned dependencies, and knows nothing about the
database, sessions or tenancy. It reads one RTSP URL and POSTs events to one
HTTP endpoint.

This file is the **hub**: the contract every worker obeys, the shape they all
share, and how the platform starts and stops them. Each module's own README has
the depth on what it actually detects and why it is built the way it is.

| Module | Detects | Model | Trained? | README |
|---|---|---|---|---|
| [`ppe/`](ppe/) | helmet · vest · gloves · boots compliance | RF-DETR-S, 9 classes | yes | [→](ppe/README.md) |
| [`vehicle/`](vehicle/) | 8 vehicle classes, counting, wrong-way, parking, congestion, triple-riding | RF-DETR-S on BMD-45 | yes | [→](vehicle/README.md) |
| [`person/`](person/) | intrusion · footfall · loitering · crowd · queue · tailgating · fall | RF-DETR-S COCO, stock | **no** | [→](person/README.md) |
| [`face/`](face/) | recognition against an enrolled gallery, with unknown-face alerting/enrolment support | YuNet + AuraFace | **frozen** | [→](face/README.md) |
| [`object/`](object/) | object left behind / removed | **none** | n/a | [→](object/README.md) |
| [`tamper/`](tamper/) | lens blocked · defocused · camera moved · feed frozen | **none** | n/a | [→](tamper/README.md) |

Half of these ship no weights at all. That is a design result, not a gap: see
*Four ways to build an analytic* below.

---

## The contract every worker obeys

```
                                     ┌─────────────────────────────────┐
rtsp://127.0.0.1:8554/cam_<id> ─────▶│  stream.py    sample N fps      │
   (MediaMTX's re-published copy,    │      ↓                          │
    NEVER the camera itself)         │  pipeline/    detect · track ·  │
                                     │               rules             │
                                     │      ↓                          │
                                     │  events.py    POST /api/        │
                                     └───────────────│─analytics/events│
                                                     └─────────────────┘
```

1. **Input.** The camera is already pulled once by MediaMTX. The worker is just
   another local reader, so it adds **zero** load on the camera — the same
   pattern the recorder uses. `stream.py` forces RTSP-over-TCP, sets
   `CAP_PROP_BUFFERSIZE=1` for low latency, `grab()`s cheaply and only
   `retrieve()`s (decodes) the frames it actually samples, and reconnects after
   3s on read failure.
2. **Inference.** A few frames per second, not 30. Sampling rate is per module
   and reasoned about, not copied: 10 fps for vehicles, 6 for people and faces,
   3 for PPE, 2 for abandoned objects, 1 for tamper.
3. **Rules.** Raw detections are never the answer. Every module turns them into
   *events* through temporal state — see below.
4. **Output.** `events.py` POSTs to the platform, which stores the event and
   raises the alert. With `POST_EVENTS=false` it prints instead, which is how
   every module is developed and debugged.

### Every module has the same file layout

```
models/<module>/
  worker.py          entry point: the frame loop, one process per camera
  stream.py          RTSP sampling (identical across modules)
  config.py          every knob, read from the environment, with the reasoning
  events.py          emit to the platform, or print
  .env.example       copy to .env
  requirements.txt   pinned
  pipeline/          detect.py, rules.py, temporal.py, zone(s).py …
  weights/           .onnx files — git-ignored, checksum-verified at spawn
  tests/             unittest; the negative cases are the point
  snapshots/         written evidence for alert events
```

Learn one module and you can read all six.

---

## Four ways to build an analytic

The modules are not variations on one technique — they deliberately use the
cheapest method that answers the question.

| Approach | Modules | Why |
|---|---|---|
| **Train a detector** | `ppe`, `vehicle` | the classes do not exist in any public checkpoint (`no_helmet`, `three_wheeler`, `lcv`) |
| **Use a stock checkpoint untouched** | `person` | `person` is COCO class 1. Seven analytics, no dataset, no GPU, no training run |
| **Freeze an embedder, search a gallery** | `face` | a closed-set classifier over 50 employees *must* map a stranger onto one of them. Nearest-neighbour + a threshold is what makes `unknown` possible |
| **No model at all** | `object`, `tamper` | dual background subtraction and image statistics answer these correctly and cost almost nothing |

---

## Raw model output is never the event

Every module that tracks applies the same four ideas, in the same order. They
are worth stating once, here, because they are the difference between a demo and
a product.

**1. Per-class confidence, not a global threshold.** Rare classes train
under-confident. One global value either floods you with false positives or
silently drops every truck. The PPE module inverts this deliberately: the
*negative* classes (`no_helmet` AP 0.30, `no_vest` 0.41, `no_boots` 0.14) get a
**higher** bar than the positives, because a false "no_helmet" is a false
accusation against a worker while a missed one is only a missed alert.

**2. Class-agnostic NMS where one object must yield one box.** Ordinary NMS only
suppresses overlaps *within* a class, so one vehicle can carry a `car` box and a
`van` box and both survive. `vehicle` runs NMS across all classes for exactly
this reason. `ppe` does the opposite — per-class NMS — because a helmet box
sitting on a person box must not suppress it.

**3. Tracking, because classification must be per-track.** A detector re-decides
every box's class from scratch on every frame, with no memory. At 10 fps the
same car is classified ten times a second and some frames land on `van`. That
flicker is not a model defect, it is the absence of temporal state. Every module
that needs identity runs **ByteTrack** (via `supervision`, MIT) over the
filtered detections, then votes per track id:

```
confidence-weighted votes accumulate per track
   → running argmax reported after VOTE_MIN_FRAMES
   → class FROZEN after VOTE_LOCK_FRAMES if the winner holds ≥ LOCK_SHARE
```

`LOCK_SHARE` is 0.75, not 0.6: at five frames a 3-vs-2 split reaches exactly 0.6
and would lock, which is noise rather than agreement. A genuinely ambiguous
track keeps voting rather than freezing an arbitrary early guess.

Detections are filtered **before** the tracker, never after — feeding junk to
the tracker creates junk tracks the voter then has to unlearn.

**4. Debounce and cooldown.** Nothing alerts on one frame. Thresholds are in
**seconds** wherever a human would think in seconds (`LOITER_SECONDS`,
`HOLD_SECONDS`, `PERSIST_SECONDS`), so they stay correct at any sample rate and
when a frame is slow. Every alert is rate-limited per (track, rule) by
`ALERT_COOLDOWN_S`.

### ByteTrack, and the one thing you must not do with it

`supervision`'s ByteTrack associates detections to tracks in two passes — first
the high-confidence boxes by IoU under a Kalman motion prediction, then the
low-confidence leftovers against still-unmatched tracks. That second pass is
what carries a track through a partial occlusion instead of killing it.

Tuning that matters:

| Parameter | Meaning |
|---|---|
| `track_activation_threshold` | confidence a detection needs to *start* a track |
| `minimum_matching_threshold` | IoU needed to associate |
| `lost_track_buffer` | frames a lost track survives before its id is retired — 30 for vehicles, **60 for people**, because people stand still and occlude each other far more, and a lost id resets every dwell timer attached to it |
| `frame_rate` | must match `SAMPLE_FPS`, or the Kalman motion model predicts at the wrong scale |

Vote history must outlive brief absences too (`TRACK_GRACE_FRAMES`, ≥ the
tracker's own buffer) — dropping state on first absence resets the vote every
time a vehicle passes behind a pole and destroys the class lock.

> **A track id is a within-session handle only.** ByteTrack re-issues ids after a
> track is lost and restarts numbering from 1 on every process start.
> **Never persist a track id as a database key.** The durable key is
> `(cameraId, at, eventId)`; `events.py` generates a UUID per event for this.
> Identity for a *specific* vehicle across sessions is not solvable by detection
> — that needs the number plate, a separate model that does not exist yet.

---

## The event contract

```json
{
  "module":   "ppe",
  "feature":  "ppe_compliance",
  "type":     "missing_helmet",
  "cameraId": "<uuid>",
  "trackId":  17,
  "at":       "2026-08-28T09:14:22.481Z",
  "details":  { "…module-specific…": true },
  "snapshot": "snapshots/ppe_ab12cd34_t17_helmet_20260828-091422.jpg"
}
```

`POST /api/analytics/events` with header `X-Ingest-Key: <org ingest token>`.
The key is per-organisation and stored only as a SHA-256 hash
(`organizations.ingest_key_hash`), so a token leaked from one on-prem site
cannot forge events for another tenant. Workers never hold a session cookie.

The platform stores it in `analytics_events` and surfaces it in the alerts and
per-module views. Snapshots are served back through
[`snapshotRoutes.ts`](../server/snapshotRoutes.ts), org-scoped.

---

## How the platform runs these

[`server/analyticsWorker.ts`](../server/analyticsWorker.ts) supervises them:
staggered startup, exponential backoff with jitter, a watchdog, and a 60-second
licence re-check that **stops** a running worker when its licence expires.

**One process per (camera, module), not per feature.** Six person analytics on
one camera share a detector and a tracker; six processes would compute the same
boxes six times. The supervisor groups the camera's `camera_analytics` rows by
module and passes the licensed feature names as `ENABLED_FEATURES`:

```
ENABLED_FEATURES=intrusion,loitering
```

An unlicensed rule is **never constructed**. It does not get hidden in the UI —
it does not exist at runtime.

Before spawning, [`modelRegistry.ts`](../server/modelRegistry.ts) verifies each
weight file's SHA-256 against `manifest.json`. Wrong weights produce
plausible-but-wrong detections, which is worse than not running. A module whose
`.venv` is missing is refused with a message to the client admin, rather than
restart-looped in silence.

---

## Running one by hand

```bash
cd models/<module>
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set SOURCE_RTSP, CAMERA_ID, and the module's knobs
python worker.py              # POST_EVENTS=false → prints instead of posting
```

Offline against a video file, where the module provides it:

```bash
python run_video.py --video ../../data/vechiledetection/VID.mp4 --fps 10
```

Tests, where the module has them:

```bash
. .venv/bin/activate && python -m unittest discover -s tests
```

The test suites deliberately target behaviours that fail **silently**: an alert
firing every frame instead of once, a dwell timer resetting on occlusion, a zone
test using the wrong reference point, a person walking through registering as an
abandoned object, a tamper baseline drifting toward the covered lens.

For production installation of the venvs, see
[`scripts/install-models.sh`](../scripts/install-models.sh) and
[deploy/README.md](../deploy/README.md).

---

## Licensing of the components we ship

Ultralytics YOLO is **AGPL-3.0**, and their licence covers "the training code
**and the models produced by that training code**". Exporting to ONNX does not
escape it, and distributing an AGPL work entitles every recipient to the
complete source of the whole application. Every runtime model was therefore
moved off YOLO.

| Component | Licence |
|---|---|
| RF-DETR **Nano / Small / Medium / Large** | Apache-2.0 |
| RF-DETR **XLarge / 2XLarge** | PML-1.0 — **never use**; needs a paid Roboflow plan |
| DINOv2 backbone | Apache-2.0 (Meta relicensed, Aug 2023) |
| `onnxruntime` | MIT |
| `supervision` (ByteTrack) | MIT |
| OpenCV / numpy | Apache-2.0 / BSD |
| YuNet (OpenCV Zoo) | MIT |
| AuraFace `glintr100` | Apache-2.0 — **provenance unconfirmed**, see [face/](face/README.md) |
| BMD-45 dataset | CC BY 4.0 — attribution required, discharged by [NOTICE](../NOTICE) |

Runtime is pure ONNX: no torch, no `rfdetr` package, no `ultralytics`. That also
makes CPU inference lighter than the torch path.

---

## Privacy — India's DPDP Act 2023

Images of identifiable people are personal data; facial data is **biometric =
sensitive personal data**. Two rules are enforced in code, not policy:

- **Only alert events store a snapshot.** Routine counting and queue summaries
  never write an image (`SNAPSHOT_EVENTS` in the person module).
- **`SAVE_UNKNOWN_SNAPSHOTS` defaults to `false`.** Storing images of
  unidentified people is the highest-risk artefact in the product; enable it only
  with a documented lawful basis.

Retention is enforced centrally by the platform's snapshot purge. Consent must
be explicit and purpose-limited at collection — access control is not employee
monitoring, and a second purpose needs fresh consent.

---

## What does not exist yet

- **ANPR / number plate.** BMD-45's plates are blurred for privacy, so it is
  useless for this. The stage is: vehicle crop → 4-corner plate detector →
  perspective rectify → OCR. Not built.
- **Vehicle colour.** BMD-45 has no colour labels; it needs a second-stage
  classifier on the vehicle crop (VCoR / VeRi-776). Not built.
- **Fire / smoke.** The trainer exists at [train_fire/](../train_fire/README.md);
  there is no `models/fire/` worker yet.
- **Pose-based fall detection.** The current `fall` rule is box geometry and says
  so in its own output (`"confidence": "heuristic"`). A real one needs MediaPipe
  or RTMPose, whose *weight* licences have not been verified — and this project
  has hit that trap three times already.
- **Owner association for abandoned objects.** Needs the person module's tracks
  fused into the object module. The obvious next improvement.
