# `models/object/` — abandoned / removed object

[← models/](../README.md) · [← root](../../README.md) · siblings: [ppe](../ppe/README.md) · [vehicle](../vehicle/README.md) · [person](../person/README.md) · [face](../face/README.md) · [tamper](../tamper/README.md)

No model, no training, no weights.

```
frame ─▶ dual background subtraction ─▶ persistence ─▶ edge test ─▶ events
```

| Event | Meaning |
|---|---|
| `object_left` | something arrived, stopped moving, and stayed |
| `object_removed` | something that was part of the scene is gone |
| `*_cleared` | the situation reverted (bag picked up again) |

## How it works without a model

```
BG_slow   learns slowly — a bag put down stays "foreground" for a long time
BG_fast   learns quickly — the same bag becomes "background" within seconds

static = foreground(slow) AND background(fast)
```

That intersection is exactly *arrived and then stopped moving*. A person walking
through is foreground in **both** (excluded); permanent scenery is background in
both (also excluded). This is the classic method and needs no weights.

## Telling LEFT from REMOVED

To a background subtractor the two are **identical** — both are "this region
changed and stayed changed". The separator is edge density inside the region
versus the stored reference frame:

- more edges than before → something was **added**
- fewer edges → something was **taken away**
- neither, clearly → **report nothing**, because a guess would be worse than
  silence

## Inside `pipeline/detect.py`

The steps between the two background models and an event:

```
frame ─▶ downscale to PROC_WIDTH (480)   analysis is cheap on purpose
      ─▶ BG_slow.apply(lr=SLOW_LR)  and  BG_fast.apply(lr=FAST_LR)
      ─▶ static = fg(slow) AND bg(fast)
      ─▶ AND zone_mask                    (OBJECT_ZONE polygon, if set)
      ─▶ MORPH_OPEN  ×1   kill speckle
         MORPH_CLOSE ×2   close gaps so one object is one blob
      ─▶ findContours, filter by MIN_AREA_FRAC … MAX_AREA_FRAC
      ─▶ IoU-match to existing candidates (MATCH_IOU) so persistence
         accumulates per object rather than restarting each frame
      ─▶ persisted ≥ PERSIST_SECONDS  →  classify LEFT vs REMOVED
```

`MOG2` is configured with **`detectShadows=False`** and a fairly high
`varThreshold`: shadows are the main source of phantom objects in outdoor
scenes, and a shadow that the subtractor labels foreground looks exactly like an
object to everything downstream.

The **reference frame** is captured during warm-up and kept. Left-vs-removed is
decided by comparing Canny edge density (`cv2.Canny(patch, 50, 150)`, normalised
by patch size) inside the region now against the same region in the reference:

```
edges_now > edges_ref × (1 + EDGE_DELTA)   →  object_left
edges_now < edges_ref × (1 − EDGE_DELTA)   →  object_removed
otherwise                                  →  report nothing
```

The upper area bound (`MAX_AREA_FRAC=0.25`) exists so a whole-scene lighting
shift is not read as one enormous object.

## Limits, stated plainly

**No owner association.** Real abandoned-baggage systems link the object to the
person who left it. That needs the person module's tracks and is not wired here —
it's the obvious next improvement.

**A parked car or a moved chair is, correctly, a left object.** `OBJECT_ZONE`
scopes detection to the area you actually care about. Without it, expect
alerts on anything that legitimately arrives and stays.

**Shadows are the classic false positive.** `detectShadows` is off and
`varThreshold` is set fairly high for this reason, but strong moving shadows in
outdoor scenes will still cost you some precision.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt      # opencv + numpy only
cp .env.example .env
python worker.py
```

## Tuning

| Key | Default | Note |
|---|---|---|
| `PERSIST_SECONDS` | 30 | airports use minutes; a shop counter might use 10 |
| `MIN_AREA_FRAC` | 0.0008 | raise to ignore small litter |
| `EDGE_DELTA` | 0.25 | lower = more decisive left/removed calls, more mistakes |
| `OBJECT_ZONE` | — | strongly recommended in any scene with legitimate parking |

## Tests

11 tests. The negative cases are the important ones — **a person walking through
must not register as an abandoned object**, and a brief pause must not either.
Both would fail silently if the dual-background logic were wrong.
