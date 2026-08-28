# `models/tamper/` — camera tamper detection

[← models/](../README.md) · [← root](../../README.md) · siblings: [ppe](../ppe/README.md) · [vehicle](../vehicle/README.md) · [person](../person/README.md) · [face](../face/README.md) · [object](../object/README.md)

No model, no training, no weights.

```
frame ─▶ image statistics vs this camera's learned baseline ─▶ events
```

Detects the four ways a camera stops being useful:

| Condition | Meaning |
|---|---|
| `blocked` | lens covered, sprayed, blacked out, or something parked in front |
| `defocused` | lens turned or knocked out of focus |
| `moved` | camera physically re-aimed |
| `signal` | frozen feed — stream alive, decoder repeating one frame |

Also emits `camera_tamper_cleared` on recovery, so an operator learns the camera
came back without having to watch it.

## Why this matters more than it looks

A blinded camera **silently** stops producing PPE, vehicle and person events.
There is no error, no crash, no gap in the logs — just an analytic that quietly
reports nothing forever. This module is the only thing that notices.

It is also the cheapest analytic here: no model file, no onnxruntime, no torch.
Just OpenCV and numpy at 1 fps.

## Two design decisions that make it work

**Relative thresholds, not absolute.** A blur or edge-density value meaning
"tampered" on one camera means "normal" on another — a foggy car park and a lit
corridor differ by an order of magnitude. Every metric is compared against a
baseline *this camera* learned from its own history, so one config works across
a whole site.

**A hold time.** A truck passing close to the lens is indistinguishable from
blocking for a second or two. Nothing alerts until the condition persists for
`HOLD_SECONDS`. This is the single biggest false-positive control.

## The four metrics

All computed on a greyscale frame downscaled to `PROC_WIDTH` (320) — analysis is
deliberately cheap, since this runs on every camera on the box.

| Metric | How | Fires |
|---|---|---|
| **Blur** | variance of the Laplacian; low means few sharp edges | drops below `(1 − BLUR_DROP)` × baseline → `defocused` |
| **Edge density** | fraction of non-zero pixels in `Canny(50, 150)` | drops below `(1 − EDGE_DROP)` × baseline → `blocked` |
| **Mean level** | `gray.mean()` | below `DARK_LEVEL` (12.0) → `blocked`, reason `dark` |
| **Frame delta** | mean absolute difference against the previous frame | below `FROZEN_DELTA` → `signal`. A live feed always carries some sensor noise, so a near-zero delta means the decoder is repeating one frame |

Blur and edge baselines are `deque(maxlen=BASELINE_FRAMES)` medians — the
camera's own recent history, which is what makes one config work across a whole
site.

### The scene signature

`moved` compares a **contrast-normalised 32×32 greyscale thumbnail** by
normalised cross-correlation in `[-1, 1]`, where 1.0 is identical structure.

```python
t = resize(gray, (32, 32), INTER_AREA).astype(float32)
t -= t.mean()
t /= t.std()
```

Subtracting the mean and dividing by the standard deviation is *exactly*
invariant to any linear brightness/contrast change (`alpha*x + beta`) — which is
what a camera's AGC does — while still changing completely on a real pan.

An HS histogram *sounds* brightness-invariant and is not: auto-exposure and gain
changes shift saturation, so a cloud passing overhead reads as the camera having
been re-aimed. That was hit during development — the brightness test failed with
`sceneSimilarity 0.283`. Both behaviours are now tested.

## The baseline never learns the tampered state

Baselines only update on frames that look untampered. Otherwise the baseline
would drift toward the covered lens and the alert would silently clear itself
while the camera was still blind. There is a test for this.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt      # opencv + numpy only
cp .env.example .env
python worker.py
```

## Tuning

| Key | Default | Raise it if... |
|---|---|---|
| `HOLD_SECONDS` | 5.0 | vehicles/people regularly pass close to the lens |
| `EDGE_DROP` | 0.40 | busy scenes trigger false `blocked` |
| `BLUR_DROP` | 0.45 | rain or fog trigger false `defocused` |
| `SCENE_CHANGE` | 0.45 | a scene with lots of legitimate motion trips `moved` |
| `WARMUP_FRAMES` | 30 | the camera's view changes a lot early on |

## Tests

```bash
python -m unittest discover -s tests
```

13 tests, each applying a real transformation (cover, blur, pan, freeze) to a
synthetic scene and checking the right condition fires — and, just as
importantly, that stable scenes, brightness swings, brief obstructions and
recolouring never do.
