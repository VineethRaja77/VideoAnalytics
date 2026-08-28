# `models/ppe/` — PPE compliance

[← models/](../README.md) · [← root](../../README.md) · siblings: [vehicle](../vehicle/README.md) · [person](../person/README.md) · [face](../face/README.md) · [object](../object/README.md) · [tamper](../tamper/README.md) · trainer: [train/](../../train/README.md)

Detects workers who are missing required Personal Protective Equipment —
helmet, vest, gloves, boots — and emits a violation only when it is confident
enough to accuse someone.

```
frame ─▶ RF-DETR (people AND PPE, one pass) ─▶ ByteTrack ids
      ─▶ zone gate ─▶ visibility (what can be judged at all)
      ─▶ body-part association ─▶ temporal verification ─▶ violation + snapshot
```

Feature: `ppe_compliance`. One process per camera. Default `SAMPLE_FPS=3`.

---

## The property the whole module is built around

**Only judge what can actually be seen. Anything not observable is reported
`not visible`, never `missing`.**

A false violation costs the client's trust far more than a missed one costs
their safety record, because the first thing a supervisor does with a noisy
system is switch it off. Everything below — the visibility stage, the
association rule, the temporal window, the inverted confidence thresholds — is
an expression of that one sentence.

So an item has three states, never two:

| State | Means |
|---|---|
| `present` | a positive class was detected on the right body region |
| `missing` | an **explicit negative** class (`no_helmet`, …) was detected on the right region |
| `unknown` | the region is not observable, or the model saw nothing conclusive |

**Absence of a positive detection is `unknown`, never a violation.** Inferring
"missing" from silence turns every small, distant or motion-blurred worker into
a false alarm.

---

## One model, both jobs

`pipeline/ppe_detect.py` runs **one** RF-DETR-Small ONNX graph that detects
people *and* every PPE class in a single pass.

```python
CLASSES = ["person",
           "helmet", "no_helmet",
           "vest",   "no_vest",
           "gloves", "no_gloves",
           "boots",  "no_boots"]
```

> **The order of that list is load-bearing.** The model emits class *indices*.
> Reordering `CLASSES` here without retraining silently mislabels every
> detection. It must match the training script's list exactly.

This replaced an ensemble of separate hardhat/vest models. A single trained
model with **explicit negative classes** is strictly better than inferring
absence from silence: it can say "this head has no helmet" rather than "no
helmet was detected anywhere", which is what produced false violations on small
or distant workers.

### The ONNX contract, verified against the exported file

```
input   (1, 3, 672, 672)   RGB, ImageNet-normalised
dets    (1, 300, 4)        cxcywh, normalised 0-1
labels  (1, 300, C+1)      C real classes + ONE BACKGROUND slot at index C
scores are SIGMOID (focal-loss DETR), not softmax
```

Four things follow, and each is a bug someone would otherwise hit:

- **Resolution is read from the model**, not from config. Hard-coding it is how
  a 672 px export silently gets fed 512 px input and quietly loses accuracy.
- **Square resize, not letterbox.** Training resized the same way, so the aspect
  distortion matches and boxes map back with a plain per-axis scale.
- **The background slot is dropped.** It is a real output column, not a class.
- **Top-k is taken over the flattened query × class grid**, so one query can
  surface several class hypotheses. DETR emits one box per query with no
  duplicate suppression of its own, hence the explicit NMS.

**NMS is per class here** — deliberately the opposite of the vehicle module — so
that a helmet box never suppresses the person box it is sitting on.

### Per-class confidence, inverted on purpose

Measured on the shipped model's validation set:

```
vest 0.77 AP | person 0.63 | boots 0.59 | helmet 0.56
no_vest 0.41 | no_helmet 0.30 | no_boots 0.14      ← negatives are much weaker
```

So the negatives get a **higher** bar, not a lower one:

| class | floor | | class | floor |
|---|---|---|---|---|
| `person` | 0.40 | | `no_helmet` | 0.55 |
| `helmet` `vest` | 0.35 | | `no_vest` | 0.55 |
| `boots` | 0.40 | | `no_gloves` | 0.65 |
| `gloves` | 0.45 | | `no_boots` | 0.75 |

A false `no_helmet` is a false accusation against a worker; a missed one is only
a missed alert. The thresholds encode which error is acceptable.

People are then passed through **ByteTrack** (`supervision`, MIT) so temporal
voting has stable ids; PPE items are returned as plain per-frame boxes.

---

## Pose: what it used to be, and what replaced it

This is the most important thing to understand about this module's history.

The original pipeline ran a **YOLO-pose** model that produced person boxes plus
**17 COCO keypoints** plus tracking. Keypoints drove visibility: a region was
"visible" if its keypoints were detected — nose and eyes for the head, shoulders
and hips for the torso, wrists for the hands, ankles for the feet. Association
then anchored each PPE detection to the relevant keypoint.

That was better. It is gone for one reason: **Ultralytics YOLO is AGPL-3.0**, and
`yolo11n-pose.pt` is covered by it. Distributing it would entitle every client to
the complete source of the whole VMS. RF-DETR is Apache-2.0 and shippable — but
**RF-DETR has no pose head**.

So the `Person` dataclass still carries a `keypoints` field and it is
**always empty**, kept name-compatible with the old `PersonPose` output. Callers
must not infer visibility from it. `visibility.py` now works from the box.

The code is honest about the downgrade rather than pretending a box tells us as
much as keypoints: the replacement rules are deliberately **conservative**, so
when in doubt a region is not visible and the item is `unknown`.

(A leftover `yolo11n-pose.pt` still sits in this directory from that era. It is
not loaded by any runtime path.)

### What a box can still tell you — `pipeline/visibility.py`

**1. Truncation.** A box touching a frame edge is cut off there.

```python
EDGE_MARGIN_PX = 4
y2 >= H - margin  →  feet are outside the image  →  drop "feet"
y1 <= margin      →  head is outside             →  drop "head"
x1/x2 at an edge  →  hands may be outside        →  drop "hands"
                     (torso is wide enough to survive on what remains)
```

**2. Scale.** Below a few dozen pixels of person height a helmet is a handful of
pixels and the detector's own confidence is meaningless. Fine items need more
resolution than coarse ones:

```python
MIN_HEIGHT_PX = {"helmet": 60, "vest": 50, "boots": 90, "gloves": 120}
```

`boots` is the region furthest from the camera in most mounts; `gloves` are tiny
and frequently occluded by the body.

**3. Aspect.** `MAX_ASPECT = 1.2` — a box far wider than tall is usually a
seated, bent or partly occluded person, where "which end is the head" stops
being reliable. Above it, **no** region is judged.

Regions are then proportional bands of the box height (standing adult
proportions), used only to *place a search region*, never to decide presence:

```python
REGION_BANDS = {"head":  (0.00, 0.28),
                "torso": (0.18, 0.65),
                "hands": (0.35, 0.75),
                "feet":  (0.80, 1.00)}
```

---

## Association — is that helmet on *this* worker? `pipeline/association.py`

A helmet on the ground, or the vest of the worker standing behind, must not
count. Each item is anchored to its region box and matched by overlap:

```python
MIN_OVERLAP = 0.30   # fraction of the PPE box that must fall inside the region
```

Generous on purpose — the proportional bands are approximate, and the point is
to reject another worker's gear, not to demand pixel alignment.

The decision order matters:

1. No positive **and** no negative class configured for an item → `unknown`.
   The model literally cannot judge it.
2. A **positive** detection on the region → `present`. Positive wins over
   negative: a detector that sees both a helmet and a bare head on one person is
   more likely right about the helmet, and crediting the worker is the safer
   error.
3. A **negative** detection on the region → `missing`.
4. Otherwise → `unknown`, unless the item is in `ABSENCE_MISSING`.

> **`ABSENCE_MISSING` defaults to empty and should stay that way.** It is the
> setting that manufactures false violations: it turns "no positive detection"
> into a violation. Add an item only when that class is *measured* to be
> reliable on your footage.

---

## Temporal verification — `pipeline/temporal.py`

Per (track, item), a rolling window of per-frame assessments. A violation is
confirmed only when both hold:

| Knob | Default | Meaning |
|---|---|---|
| `TEMPORAL_WINDOW` | 30 | frames kept per track |
| `TEMPORAL_MIN_FRAMES` | 12 | conclusive observations required before deciding |
| `VIOLATION_RATIO` | 0.7 | fraction of those that must be `missing` |
| `ALERT_COOLDOWN_S` | 60 | per (track, item), so one worker cannot spam alerts |

Only `present`/`missing` frames count toward the ratio; `unknown` frames are
ignored rather than diluting it. `forget_absent()` drops state for tracks that
have left the frame.

The confirmed event carries `missingRatio`, `framesObserved`, the visible region
list, and the full per-item compliance snapshot — so an operator reviewing the
alert can see *why*, not just *what*.

---

## Zone gate — `pipeline/zone.py`

`ZONE_LINE="x1,y1,x2,y2"`. Only workers who have entered the restricted area are
analysed. "Inside" is decided by the sign of a 2D cross product against the
**feet** — the bottom-centre of the box, not the centroid. The centroid of a
tall box sits well above where the person is standing, so a centroid test fires
early on approach and late on exit.

Empty `ZONE_LINE` disables the gate and everyone is analysed. If your restricted
area is *above* the line, flip the sign in `ZoneGate.inside`.

---

## Configuration

| Key | Default | Note |
|---|---|---|
| `SOURCE_RTSP` | — | required; point at `cam_<id>` on MediaMTX |
| `CAMERA_ID` | — | the platform's camera UUID |
| `SAMPLE_FPS` | 3 | PPE is a slow-changing property |
| `MODEL_PATH` | `weights/ppe_rfdetr.onnx` | the `.pth` checkpoint is **not** used at runtime |
| `PERSON_CONF` / `PPE_CONF` | 0.40 / 0.35 | floors; `PER_CLASS_CONF` applied after |
| `IOU_NMS` | 0.5 | per-class |
| `ZONE_LINE` | — | empty = analyse everyone |
| `TEMPORAL_*`, `VIOLATION_RATIO` | see above | |
| `REQUIRED_PPE` / `NEGATIVE_PPE` | item → class names | JSON; extend when a model gains classes |
| `ABSENCE_MISSING` | `[]` | leave empty — see the warning above |
| `POST_EVENTS` | `false` | `false` prints violations instead of posting |
| `SAVE_SNAPSHOTS` | `true` | annotated JPEG into `SNAPSHOT_DIR` |

---

## Run

```bash
cd models/ppe
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set SOURCE_RTSP, CAMERA_ID
python worker.py
```

Offline against a file:

```bash
python run_video.py --video ../../data/"PPE FILES"/clip.mp4 --fps 3
```

**If the weights are missing** the worker still runs: it prints a warning, marks
the detector unavailable, and every item reports `unknown`. Nothing downstream
fabricates a violation. That is the intended failure mode.

---

## Emitted event

```json
{
  "module": "ppe",
  "feature": "ppe_compliance",
  "type": "missing_helmet",
  "cameraId": "…",
  "trackId": 17,
  "at": "2026-08-28T09:14:22Z",
  "details": {
    "item": "helmet",
    "missingRatio": 0.83,
    "framesObserved": 18,
    "visible": ["head", "torso"],
    "compliance": {"helmet": "missing", "vest": "present"}
  },
  "snapshot": "snapshots/ppe_ab12cd34_t17_helmet_20260828-091422.jpg"
}
```

---

## Known gaps

- **Visibility is weaker than it was.** Box geometry cannot match 17 keypoints.
  A pose head on an Apache-2.0 model would restore it; the licence audit of
  candidate pose weights has not been done.
- **`no_boots` AP is 0.14.** Its 0.75 floor makes it nearly silent by design.
  Treat boots as effectively unenforced until the class is retrained.
- **Gloves need 120 px of person height.** On a wide-angle pole camera that is
  almost never met, so gloves will usually report `unknown`. This is correct
  behaviour, not a bug — but it means glove enforcement needs its own camera.
- **No tests yet.** `tests/` is empty. The vehicle, person, object, face and
  tamper modules all have suites; this one is the outlier.

Training this model: [train/README.md](../../train/README.md).
