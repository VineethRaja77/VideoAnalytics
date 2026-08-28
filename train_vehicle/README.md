# Vehicle Type Detector — training bundle

Same pattern as `train/train_ppe_kaggle.py`: one self-contained script that builds
the dataset from public data and trains a YOLO11 detector on Kaggle GPU.

## Classes (8)

| id | class | merged from BMD-45 |
|----|-------|--------------------|
| 0 | `two_wheeler`   | Two-wheeler |
| 1 | `three_wheeler` | Three-wheeler (auto-rickshaw) |
| 2 | `car`           | Hatchback, Sedan, SUV, MUV |
| 3 | `van`           | Van |
| 4 | `lcv`           | LCV, Tempo-traveller |
| 5 | `truck`         | Truck |
| 6 | `bus`           | Bus, Mini-bus |
| 7 | `bicycle`       | Bicycle |

Set `FINE_GRAINED = True` in the script to keep all 13 original classes instead.

## Data source

**BMD-45** — https://huggingface.co/datasets/iisc-aim/BMD-45 (public, ungated, no login)

- 45,986 images / 480K boxes from **3,679 Bengaluru Traffic Police Safe City CCTV cameras**
- Pole-mounted **4–8 m, oblique viewing angles**, 1920×1080 — the same camera
  geometry as a real deployment, which is why it transfers where COCO does not.
  The BMD-45 paper reports **83.8% mAP** training on it vs **33.6%** training on
  COCO/UA-DETRAC and testing on this domain.
- Official split: 35,792 train / 10,194 val.

Verified box counts in the train split:

```
two_wheeler 171,283 | car 79,736 | three_wheeler 65,899 | lcv 22,175
bus 15,338 | truck 9,968 | bicycle 4,713 | van 4,020
```

### Known limits — plan around these

- **Daytime only** (06:00–18:00). Night / IR is your gap.
- **License plates and faces are blurred.** Fine for vehicle detection; it is
  exactly why ANPR has to be a separate model trained on your own footage.
- Bengaluru only.
- The paper describes a 14th `Other` class — it is **not** in the released
  annotations. Only the 13 above exist.

## Run it

1. Kaggle notebook → Settings → **Accelerator = GPU**, **Internet = ON**.
2. Upload `train_vehicle_kaggle.py` (or this whole zip as a Kaggle Dataset).
3. `!python train_vehicle_kaggle.py`
4. Model → `/kaggle/working/vehicle_best.pt`

### Adding your own CCTV frames

Put them in a folder named `frames_labeled/` (images + YOLO `.txt`) or `frames/`
(images only → auto-prelabeled with COCO YOLO11). The script auto-locates it
under `/kaggle/input`.

Caveat on auto-prelabeling: COCO has **no auto-rickshaw, LCV or tempo-traveller**
class, so those come out mislabeled as car/truck or get missed entirely. Review
them in CVAT. Everything else it labels for free.

## Tuning

| knob | default | note |
|------|---------|------|
| `CAP_BMD_TRAIN` | 20000 | of 35,792. Use **5000** for a fast first run |
| `CAP_BMD_VAL`   | 2500  | of 10,194 |
| `MODEL`         | `yolo11s.pt` | `n` faster, `m` more accurate |
| `IMGSZ`         | 960   | CCTV vehicles are small/far — don't drop below 640 |
| `EPOCHS`        | 100   | early-stops at `PATIENCE=20` |

### Why the image cap is not a plain truncation

`select_images()` scores each image by the inverse frequency of the classes it
contains and takes the richest first. `van` and `bicycle` are ~1% of boxes each,
so plain head-truncation to a small cap can yield **zero** of them. Verified: a
60-image sample still contained all 8 classes.

### Disk / bandwidth

BMD-45 images are 2.16 MB PNGs — **~100 GB for the full set**, which does not fit
on Kaggle. The script downloads each PNG, immediately re-encodes to JPEG q88 at
1280 px (~0.12 MB) and **deletes the PNG**. Peak disk stays ~3 GB for 20K images.
Downloading 20K images pulls ~43 GB over the network — roughly 20–40 min on Kaggle.

## Production calibration (runs automatically after training)

After training, the script derives the runtime settings and writes
**`/kaggle/working/vehicle_profile.json`**. Download it together with
`vehicle_best.pt` — the VMS runtime loads both.

It contains:

| field | what it is |
|-------|-----------|
| `conf_threshold` | **per-class** confidence, at the peak of that class's F1-vs-confidence curve on the val set |
| `global_conf_floor` | run the detector at this, then filter with the per-class value |
| `geometry.*.ar_reject_below/above` | p1/p99 aspect-ratio outlier gate |
| `geometry.*.min_size_px` | `sqrt(w*h)` below this is smaller than the training data annotates — unreliable |
| `geometry.*.ar_median/p5/p95` | reference distribution |

### Two things to get right when you use it

**Confidence is per class, not global.** Rare classes (`van`, `bicycle`, `truck`)
train under-confident and need a lower threshold than `car` or `two_wheeler`. A
single global threshold either floods you with false positives or silently drops
every truck. The F1 peak is clamped to `[0.15, 0.75]` — a peak under 0.15 means
the model barely learned that class, and shipping it would flood the runtime with
false positives on cameras it has never seen.

**Do NOT use aspect ratio to decide class.** Measured across all 479,536 BMD-45
boxes, the per-class AR spread is 3–4× — that spread *is* the camera-angle
variation, and it makes the classes overlap almost completely:

```
car  AR p5-p95 = 0.76 - 2.05
bus  AR p5-p95 = 0.62 - 2.58     <- nearly identical range
```

Side-on gives a wide box, head-on gives a tall one. AR is only useful as a loose
garbage filter (rejecting a "bus" at AR 4.0 = a fused double detection), which is
why the reject bounds are p1/p99 and not p5/p95.

**For tight gates, calibrate per camera.** One fixed camera has one angle, so its
per-class AR spread is narrow and genuinely discriminative. Re-run
`geometry_priors()` over one camera's footage to get a per-camera profile. The
global numbers are the starting point, not the destination.

**Night:** BMD-45 is daylight-only, so these thresholds are optimistic after dark
until you add site night frames.

## Verified before shipping

- BMD-45 repo public and reachable; 13 categories read from the real COCO json
- 80-image fetch: **0 download failures**, 0 corrupt labels
- All 41 sampled boxes within `[0,1]`; overlays render correctly on the vehicles
- 2-epoch CPU training completes and emits `best.pt` + per-class mAP

## Next: number plate (separate model)

BMD-45's blurred plates make it useless for ANPR. That stage is:
vehicle crop → plate detector (4-corner, then perspective-rectify) → OCR.
Pretrain plate detection on CCPD + RodoSol + UFPR, train OCR on synthetic Indian
plates warped onto real plate corners, then adapt with pseudo-labeled site
footage (format-regex + multi-frame majority vote). Not built yet.

## Vehicle colour

Not possible from this dataset — BMD-45 has no colour labels. It needs a separate
second-stage classifier on the vehicle crop, trained on VCoR (~10K images, 15
colours) or VeRi-776 (surveillance vehicles, 10 colours). Both public. Not built yet.
