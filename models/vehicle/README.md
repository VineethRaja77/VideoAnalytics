# `models/vehicle/` — vehicle detection, classification, counting and traffic rules

[← models/](../README.md) · [← root](../../README.md) · siblings: [ppe](../ppe/README.md) · [person](../person/README.md) · [face](../face/README.md) · [object](../object/README.md) · [tamper](../tamper/README.md) · trainer: [train_vehicle/](../../train_vehicle/README.md)

```
frame ─▶ RF-DETR ─▶ class-agnostic NMS ─▶ per-class conf ─▶ geometry gate
      ─▶ ByteTrack ─▶ per-track class vote ─▶ counting line
      ─▶ crossing event + snapshot          └▶ rule features (no extra model)
```

Five licensable features from one process: `vehicle_count`, `wrong_way`,
`illegal_parking`, `congestion`, `triple_riding`. One process per camera,
`SAMPLE_FPS=10`.

---

## Classes (8)

`two_wheeler` `three_wheeler` `car` `van` `lcv` `truck` `bus` `bicycle`

Merged from BMD-45's 13 fine-grained labels (hatchback/sedan/SUV/MUV → `car`;
LCV + tempo-traveller → `lcv`; bus + mini-bus → `bus`). Set `FINE_GRAINED=True`
in the trainer to keep all 13.

### The dataset — BMD-45

[huggingface.co/datasets/iisc-aim/BMD-45](https://huggingface.co/datasets/iisc-aim/BMD-45)
— 45,986 images / 480K boxes from **3,679 Bengaluru Traffic Police Safe City
CCTV cameras**, pole-mounted 4–8 m at oblique angles, 1920×1080. CC BY 4.0:
commercial use permitted, attribution required (discharged by [NOTICE](../../NOTICE)).

That camera geometry is the whole point. The BMD-45 paper reports **83.8% mAP**
training on it versus **33.6%** training on COCO/UA-DETRAC and testing in this
domain. Public generic-object datasets do not transfer to pole-mounted CCTV.

Verified box counts in the train split:

```
two_wheeler 171,283 | car 79,736 | three_wheeler 65,899 | lcv 22,175
bus 15,338 | truck 9,968 | bicycle 4,713 | van 4,020
```

Known limits, plan around them: **daytime only** (06:00–18:00); plates and faces
are **blurred** (which is exactly why ANPR must be a separate model on your own
footage); Bengaluru only; the paper's 14th `Other` class is not in the released
annotations.

### Which weights are actually running

Two trainers exist, and the runtime is the RF-DETR one.

| Run | mAP50 | mAP50-95 | Ships? |
|---|---|---|---|
| YOLO11s @ 960 px, 51 epochs | 0.8911 | 0.7702 | **No — AGPL-3.0** |
| RF-DETR-S @ 512 px, 19 epochs | 0.8723 | 0.7321 | yes, superseded |
| RF-DETR-S @ 640 px, 40 epochs | current `weights/vehicle_rfdetr.onnx` | | yes |

The YOLO numbers are better and are recorded honestly, but Ultralytics' AGPL-3.0
licence covers the models produced by its training code, so those weights cannot
ship in a closed-source product. The RF-DETR trainer traded image cap for
resolution and epochs to close the gap — see
[train_vehicle/README.md](../../train_vehicle/README.md).

---

## Why raw model output is not the answer

Four stages sit between the detector and a usable event. Each fixes a specific
failure you can see in raw output.

### 1. Class-agnostic NMS (`AGNOSTIC_NMS=true`)

Ordinary NMS only suppresses overlapping boxes **of the same class**. So one
vehicle can carry a `car` box *and* a `van` box at once and both survive.
Agnostic NMS forces one box per physical object. This is the main fix for two
conflicting labels stacked on a single vehicle.

(The PPE module runs *per-class* NMS for the opposite reason: a helmet box must
not suppress the person box it sits on. Same primitive, opposite requirement.)

### 2. Per-class confidence

Not one global threshold. Rare classes (`van`, `truck`, `bicycle`) train
under-confident and need a lower bar; abundant ones (`car`, `two_wheeler`) need
a higher one. A single global value either floods you with false positives or
silently drops every truck.

```python
DEFAULT_CONF = {"two_wheeler": 0.40, "three_wheeler": 0.40, "car": 0.40,
                "van": 0.30, "lcv": 0.35, "truck": 0.30, "bus": 0.35,
                "bicycle": 0.30}
```

Defaults are derived from BMD-45 label statistics, not guessed. A
`vehicle_profile.json` beside `config.py` overrides them automatically — see
*Calibration*.

### 3. Geometry gate — and why it is deliberately loose

Rejects boxes outside per-class aspect-ratio bounds and below
`MIN_SIZE_PX=28` (measured as `sqrt(w*h)`, i.e. smaller than the training data
annotates, so untrustworthy regardless of confidence score).

**Aspect ratio can never be used to decide a class.** Measured over all 479,536
BMD-45 boxes the per-class AR spread is 3–4× — *that spread is the camera-angle
variation* — and the classes overlap almost entirely:

```
car  AR p5–p95 = 0.76 – 2.05
bus  AR p5–p95 = 0.62 – 2.58     ← nearly identical range
```

Side-on gives a wide box, head-on a tall one. So the bounds here are ~p1/p99:
they kill fused and degenerate boxes, nothing more. For genuinely tight gates,
calibrate **per camera** — one fixed camera has one angle, so its per-class
spread is narrow and actually discriminative.

Both filters run **before** the tracker. Feeding junk to the tracker creates
junk tracks that the class voter then has to unlearn.

### 4. Per-track class voting — `pipeline/temporal.py`

**Detection is per-frame; classification must be per-track.**

The detector re-decides every box's class from scratch on every frame, with no
memory. At 10 fps the same car is classified 10×/second and some frames land on
van/lcv — that is the flicker in raw output. It is not a model defect, it is the
absence of temporal state.

```
confidence-weighted votes per track id
  → running argmax reported after VOTE_MIN_FRAMES  (5)
  → class FROZEN after VOTE_LOCK_FRAMES (12) if the winner holds ≥ LOCK_SHARE
```

`LOCK_SHARE = 0.75`, **not** 0.6. At `lock_frames=5` a 3-vs-2 split reaches
exactly 0.6 and would lock — that is noise, not agreement, and it is precisely
the ambiguous van/lcv case that should keep voting. 0.75 needs a genuine
majority (4:1 at five frames, 9:3 at twelve). A track that keeps flip-flopping
never locks and keeps voting rather than freezing an arbitrary early guess.

`stability()` returns the winner's vote share, which ships in the event as a
confidence *in the class itself* — distinct from the detector's per-frame score.
In `run_video.py` output, a `*` after a class name means locked.

**`TRACK_GRACE_FRAMES=30` is essential, not hygiene.** ByteTrack keeps ids alive
across short occlusions (a vehicle behind a pole, one missed detection), so a
track absent from *this* frame is usually the same vehicle and will reappear with
the same id. Purging on first absence resets its vote to zero every time, which
destroys the class lock and inflates the track count. Keep it at or above the
tracker's own `lost_track_buffer`.

---

## Counting: crossings, not presence — `pipeline/zone.py`

`COUNT_LINE=x1,y1,x2,y2`. A track is counted **once**, when its centroid crosses
the line, with direction (`in`/`out`) from the sign flip of a 2D cross product.

Counting vehicles *visible per frame* would count a parked car once per frame —
600 counts for one stationary vehicle. Crossing-based counting also bounds the
identity problem: a track only has to hold its id for the instant it crosses,
not for its entire trajectory.

Two details that matter on a 24/7 process:

- **`prev_side` is dropped late, not eagerly.** A track missing from one frame is
  usually occluded. Dropping "which side was it on" too soon makes the next
  detection look like a fresh track and the crossing is never registered. The
  voter's still-tracked set (which already applies the grace window) is passed in
  for exactly this.
- **`counted` is *not* purged on track loss**, or a vehicle lingering near the
  line would be counted twice. It is bounded instead by a TTL
  (`counted_ttl_frames = 3000`) swept every 500 frames, so memory stays bounded
  on a worker that runs for months.

The event uses the **voted** class, never the single-frame class — the whole
point of the vote is that one frame must not decide a vehicle's identity. If a
vehicle crosses before enough frames accumulated, the per-frame class is used and
`classLocked: false` says so.

Periodic summaries (`SUMMARY_INTERVAL_S=60`) emit the **delta** for the window,
not lifetime totals. Sending cumulative counts alongside a `windowSeconds` field
would make every summary look like ever-growing traffic.

---

## Rule features — `pipeline/rules.py`

Every rule runs on the detections and tracks the worker **already** produces, so
the marginal cost of a new feature is a rules class, not a training run. Only
the org's licensed features are constructed (`ENABLED_FEATURES`), and one rule
raising an exception cannot take down counting or the other rules — the worker
would otherwise die and the supervisor would restart it in a loop.

| Feature | Rule | Key idea |
|---|---|---|
| `wrong_way` | reuses the counting line's crossing direction | direction was always in the event; this gives it a meaning. `WRONG_WAY_ALLOWED=in\|out` |
| `illegal_parking` | stationary inside `PARKING_ZONE` for `PARKING_SECONDS` (120) | "stationary" is centroid movement relative to the vehicle's **own box size** (`PARKING_MOVE_FRACTION=0.15`), not absolute pixels — a distant vehicle moves fewer pixels for the same real distance, so a fixed pixel threshold calls every far-away moving vehicle parked |
| `congestion` | `CONGESTION_LIMIT` (12) vehicles in `CONGESTION_ZONE` | **rolling median** over `CONGESTION_WINDOW_FRAMES` (15), not the instantaneous count: detection drops a vehicle for a frame constantly and a raw count would flap across the threshold and emit a burst of alerts |
| `triple_riding` | 3+ people overlapping one two-wheeler | **needs person boxes, which this model does not produce.** Rather than pretend, the rule counts people only if the caller supplies them — enable the [person module](../person/README.md) on the same camera |

Zones are image-space polygons `x1,y1,x2,y2,x3,y3,…`. **An empty polygon means
the whole frame**, not "nothing" — an unconfigured rule watches everything rather
than silently never firing.

---

## Track ids are not durable

A track id is a **within-session handle only**. ByteTrack re-issues ids after a
track is lost and restarts numbering from 1 on every process restart.

**Never persist a track id as a database key.** The durable key is
`(cameraId, at, eventId)` — `events.py` generates a UUID per event for this.

Global identity for a *specific* vehicle across sessions is not solvable by
detection at all. That needs the number plate, which is a separate model that
does not exist yet.

---

## Calibration (`vehicle_profile.json`)

The training script's `calibrate()` stage produces per-class F1-optimal
confidence thresholds and geometry bounds:

| Field | What it is |
|---|---|
| `conf_threshold` | per-class confidence at the peak of that class's F1-vs-confidence curve on the val set, clamped to `[0.15, 0.75]` |
| `global_conf_floor` | run the detector at this, then filter per class |
| `geometry.*.ar_reject_below/above` | p1/p99 aspect-ratio outlier gate |
| `geometry.*.min_size_px` | below this, smaller than the training data annotates |

**This file does not exist yet** — the Kaggle session hit its 12-hour wall at
epoch 51, before calibration ran. Until it does, the module uses
`config.DEFAULT_CONF` / `DEFAULT_AR`. Dropping the file beside `config.py`
overrides them automatically; no code change.

---

## Configuration

| Key | Default | Note |
|---|---|---|
| `SOURCE_RTSP` / `CAMERA_ID` | — | required |
| `SAMPLE_FPS` | 10 | practical floor. Below ~5 fps a vehicle can cross the line between two sampled frames and be missed entirely |
| `MODEL_PATH` | `weights/vehicle_rfdetr.onnx` | resolution is read **from the graph** (512 for Small); `IMG_SIZE` is only a fallback |
| `CONF` / `IOU_NMS` | 0.25 / 0.6 | detector floor; per-class filter applied after |
| `AGNOSTIC_NMS` | `true` | |
| `MIN_SIZE_PX` | 28 | |
| `VOTE_WINDOW` / `VOTE_MIN_FRAMES` / `VOTE_LOCK_FRAMES` | 30 / 5 / 12 | |
| `TRACK_GRACE_FRAMES` | 30 | ≥ the tracker's `lost_track_buffer` |
| `COUNT_LINE` | — | empty = detect only, no counting |
| `ENABLED_FEATURES` | `vehicle_count` | set by the supervisor from the org's licences |
| `ALERT_COOLDOWN_S` | 60 | |
| `SUMMARY_INTERVAL_S` | 60 | 0 = off |
| `POST_EVENTS` | `false` | |

---

## Run

```bash
cd models/vehicle
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # set SOURCE_RTSP, CAMERA_ID, COUNT_LINE
python worker.py
```

Offline check against a video file:

```bash
python run_video.py --video ../../data/vechiledetection/VID.mp4 \
                    --fps 10 --line 0,620,478,620
```

Tests:

```bash
python -m unittest discover -s tests     # test_pipeline.py, test_rules.py
```

`calibrate.py` derives per-camera thresholds from local footage.

---

## Known gaps

- **Night / IR** — BMD-45 is daytime only (06:00–18:00). Expect degradation
  after dark until site night frames are added and the model fine-tuned.
- **`vehicle_profile.json` missing** — see *Calibration*.
- **Vehicle colour** — not supported. BMD-45 has no colour labels; it needs a
  separate classifier on the vehicle crop (VCoR / VeRi-776).
- **Number plate / ANPR** — separate model. BMD-45's plates are blurred for
  privacy. The stage would be: vehicle crop → 4-corner plate detector →
  perspective rectify → OCR, pretrained on CCPD/RodoSol/UFPR, then adapted with
  pseudo-labelled site footage. Not built.
- **`triple_riding` is inert alone** — it needs the person module co-resident on
  the same camera.
