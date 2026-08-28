# `models/person/` — seven people analytics, one worker, no training

[← models/](../README.md) · [← root](../../README.md) · siblings: [ppe](../ppe/README.md) · [vehicle](../vehicle/README.md) · [face](../face/README.md) · [object](../object/README.md) · [tamper](../tamper/README.md)

```
frame ─▶ RF-DETR person detect ─▶ ByteTrack ─▶ enabled rules ─▶ events
```

| Feature | What it emits |
|---|---|
| `intrusion` | someone entered a restricted polygon |
| `people_count` | line-crossing footfall + periodic occupancy |
| `loitering` | dwell in a zone beyond a threshold |
| `crowd_density` | too many people in a zone |
| `queue_dwell` | queue length + average/max wait |
| `tailgating` | N people crossing a line inside a short window |
| `fall` | possible fall, from box geometry |

---

## Nothing was trained

`person` is **COCO class 1** in the stock RF-DETR checkpoint, so the Apache-2.0
model detects it out of the box. Setup is one export:

```bash
python -c "import rfdetr; rfdetr.RFDETRSmall().export(output_dir='weights')"
mv weights/rfdetr-small.onnx weights/person_rfdetr.onnx
```

No dataset, no GPU, no Kaggle run. Seven licensable features for the cost of an
export — which is why this module exists in the shape it does.

Licence chain, all shippable in a closed-source commercial product:

| Component | Licence |
|---|---|
| RF-DETR Small weights | Apache-2.0 |
| DINOv2 backbone | Apache-2.0 |
| onnxruntime | MIT |
| supervision (ByteTrack) | MIT |
| OpenCV / numpy | Apache-2.0 / BSD |

**Never** `RFDETRXLarge` / `RFDETR2XLarge` — those are PML-1.0 and need a paid
Roboflow plan.

### The output contract, verified against the exported graph

```
dets   (1, Q, 4)     normalised cxcywh
labels (1, Q, C+1)   C COCO classes + ONE background slot
class index == COCO category_id, so person is index 1
```

Confirmed empirically on a real frame (person 0.887 / car 0.925 / motorcycle),
not assumed from documentation. Detections are filtered to class 1, NMS'd, then
gated on `MIN_HEIGHT_PX` before they ever reach the tracker.

---

## One process, seven features

`ENABLED_FEATURES` is set by the platform supervisor from the org's **licensed**
features. Detection and tracking run once per frame and every enabled rule reads
the same tracks.

Running these as seven workers would recompute identical boxes seven times per
frame. An unlicensed rule is never constructed — it does not merely get hidden,
it does not exist at runtime.

**One rule failing cannot take down the other six.** Rule exceptions are caught
per rule; otherwise the worker would die and the supervisor would restart it in
a loop.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python worker.py
```

---

## Configuration

Zones are image-space polygons `x1,y1,x2,y2,x3,y3,...` (≥3 points); lines are
`x1,y1,x2,y2`. `INTRUSION_ZONE` is the fallback for the other zone rules, so a
simple site configures one polygon. **An empty polygon means the whole frame**,
not "nothing" — an unconfigured rule watches everything rather than silently
never firing.

| Key | Default | Note |
|---|---|---|
| `SAMPLE_FPS` | 6 | people move far slower than vehicles; leaves CPU for several cameras per box |
| `CONF` / `IOU_NMS` | 0.40 / 0.6 | |
| `MIN_HEIGHT_PX` | 40 | below this, dwell/crossing rules produce noise |
| `MAX_ASPECT` | 2.5 | generous on purpose — the fall rule depends on wide boxes being kept |
| `LOST_TRACK_BUFFER` / `TRACK_GRACE_FRAMES` | 60 / 60 | see below |
| `INTRUSION_MIN_FRAMES` | 3 | kills corner-clipping false alarms |
| `LOITER_SECONDS` | 60 | **seconds**, so it is independent of fps |
| `CROWD_LIMIT` / `CROWD_WINDOW_FRAMES` | 10 / 15 | smoothed |
| `TAILGATE_PEOPLE` / `TAILGATE_WINDOW_S` | 2 / 3 | |
| `FALL_ASPECT` / `FALL_DROP_FRACTION` / `FALL_HOLD_S` | 1.0 / 0.15 / 2.0 | |
| `ALERT_COOLDOWN_S` | 60 | per track, per rule |
| `SNAPSHOT_EVENTS` | `intrusion,loitering,fall,tailgating` | alert events only |

---

## How each rule actually works

### `intrusion`

Fires once per track per entry, not once per frame, and only after the person
has been inside for `INTRUSION_MIN_FRAMES`. A single frame of a box clipping a
zone corner is a false alarm, and at 6 fps that happens constantly on
boundaries. Leaving the zone clears the entry timer, so a re-entry is a new
event.

### `people_count`

Counts **crossings**, not presence, so a person standing in view is counted
once rather than once per frame. Periodic summaries emit the **delta** for the
window plus current occupancy — sending cumulative totals alongside a
`windowSeconds` field would make every summary look like ever-growing footfall.

### `loitering`

Dwell is wall-clock seconds, so `LOITER_SECONDS=60` means a minute at any
`SAMPLE_FPS` and stays correct when a frame is slow.

### `crowd_density`

Alerts on a **rolling median** of the in-zone count over `CROWD_WINDOW_FRAMES`,
never the instantaneous value. Detection drops a person for a frame constantly;
a raw count would flap across the threshold and emit a burst of alerts. The
median holds through a single dropped frame but still clears once the crowd
genuinely disperses — both behaviours are tested. The event carries the median
*and* the instantaneous count, plus density per square pixel when the zone has
a computable area.

### `queue_dwell`

Queue length is the in-zone track count; wait time is the **mean dwell of
everyone currently in the zone** — a live estimate, not a completed-service
measurement. Leaving the zone drops the timer. Emits `avgWaitSeconds` and
`maxWaitSeconds` on an interval.

### `tailgating`

A sliding time window of line crossings. Alerts when `TAILGATE_PEOPLE` or more
cross within `TAILGATE_WINDOW_S`, reporting the participating track ids.

### `fall`

Three conditions, all required, then held:

```
aspect w/h ≥ FALL_ASPECT            a standing box is tall, a fallen one wide
AND box bottom dropped by more than FALL_DROP_FRACTION × the track's own
    reference height (the MAX height seen earlier in the track, before collapse)
AND both hold continuously for FALL_HOLD_S
```

The reference height comes from the track's own history rather than a constant,
so it works at any distance from the camera. The hold is what separates a fall
from someone crouching or a box briefly deforming.

---

## Decisions worth knowing

**Zone tests use the feet, not the centroid.** A person's position is the
bottom-centre of their box. The centroid of a tall box sits well above where
they are standing, so centroid tests fire early on approach and late on exit.

**Dwell is wall-clock, not frames.** Every duration threshold in this module is
in seconds for the same reason.

**Longer track buffer than the vehicle module** (60 vs 30). People stand still
and occlude each other far more than vehicles, and losing a track id resets
every dwell timer attached to it. `TRACK_GRACE_FRAMES` matches it, so rule state
survives the same occlusions the tracker does.

---

## Two honest limitations

**`fall` is a heuristic, not a pose model.** It is materially weaker than a
pose-based detector and will miss falls toward or away from the camera, where
the box stays tall. It reports `"confidence": "heuristic"` so downstream never
mistakes it for ground truth.

Pose-based fall detection needs MediaPipe or RTMPose; their *code* is Apache-2.0
but the *weight* licences have not been verified, and this project has hit that
trap three times already (Ultralytics weights, AuraFace bundling, RF-DETR
XL/2XL). The same constraint is why the [PPE module](../ppe/README.md) lost its
keypoint-based visibility stage.

**`tailgating` is the vision half only.** Real tailgating means one badge and
two bodies. Without an access-control signal this reports "N people crossed
within W seconds" — correlate it with a door event to call it a violation.

---

## Privacy — DPDP Act 2023

Images of identifiable people are personal data. Only **alert** events store a
snapshot (`SNAPSHOT_EVENTS`); routine counting and queue summaries never write
one. Retention is enforced centrally by the platform's snapshot purge.

---

## Tests

```bash
. .venv/bin/activate && python -m unittest discover -s tests
```

26 tests. They pin the behaviours that fail *silently* rather than loudly: an
alert firing every frame instead of once, a dwell timer resetting on occlusion,
a zone test using the wrong reference point, an unknown feature crashing the
worker instead of being skipped.
