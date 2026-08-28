# `train/` — the PPE + person detector, and the labelling pipeline

[← back to the root README](../README.md) · siblings: [train_vehicle/](../train_vehicle/README.md) · [train_fire/](../train_fire/README.md) · [data/](../data/README.md) · consumer: [models/ppe/](../models/ppe/README.md)

Two separate things live here:

1. **`train_ppe_rfdetr_kaggle.py`** — the shipping trainer. One self-contained
   file, run on Kaggle, produces `ppe_rfdetr.onnx`.
2. **`scripts/`** — the dataset pipeline that builds the training set from site
   footage plus public data, including the CVAT labelling loop.

`train_ppe_kaggle.py` is the superseded YOLO11 version, kept for reference. Its
output cannot ship — see *Licensing* below.

---

## The 9 classes

```yaml
0: person
1: helmet    2: no_helmet
3: vest      4: no_vest
5: gloves    6: no_gloves
7: boots     8: no_boots
```

([`dataset/data.yaml`](dataset/data.yaml) — the only tracked file under
`dataset/`; the images and labels are git-ignored.)

**Explicit negative classes are the design.** A model that can say "this head
has no helmet" is fundamentally better than one that says "no helmet was
detected anywhere", because the second is indistinguishable from a missed
detection on a small or distant worker. The runtime depends on this: see
*"missing" requires an explicit negative* in
[models/ppe/README.md](../models/ppe/README.md).

**The order of that list is load-bearing.** The exported model emits class
indices, so `models/ppe/config.py`'s `CLASSES` must match it exactly. A
reordering silently mislabels every detection at runtime.

---

## Licensing — why the YOLO trainer was replaced

`models/ppe/` used to import `ultralytics` at runtime, and the weights were
YOLO-trained. Ultralytics YOLO is **AGPL-3.0**, and their licence explicitly
covers "the training code **and the models produced by that training code**".
AGPL is free of charge, but its price is source disclosure: distributing it
entitles every recipient to the complete source of the whole application. So did
`yolo11n-pose.pt`, which drove the old keypoint-based visibility stage.

RF-DETR is Apache-2.0 — verified chain: `rfdetr` code, RF-DETR N/S/M/L weights,
and the DINOv2 backbone are all Apache-2.0.

> **Never use `RFDETRXLarge` / `RFDETR2XLarge`.** They are PML-1.0 and need a
> paid Roboflow plan. They are not even installed by `rfdetr[train]`.

### Dataset licensing — why the old sources were dropped

The four datasets the YOLO script auto-downloaded were checked against their
HuggingFace metadata and are **not** usable commercially:

| Dataset | Declared licence |
|---|---|
| `hiennguyen9874/ppe-detection` | none declared |
| `hf-vision/hardhat` | none declared |
| `BIDJOE/ppe-14classes` | none declared |
| `Francesco/construction-safety-gsnvb` | "cc" — variant unspecified |

**No declared licence means all rights reserved** — no permission at all, which
is worse than a restrictive licence. Training on them would put the same cloud
over the new weights that AGPL put over the old ones.

One correction worth generalising: the HuggingFace *mirror* of
`construction-safety-gsnvb` declares an ambiguous "cc", while the **Roboflow
original declares CC BY 4.0 explicitly**. So that data *is* usable — taken from
Roboflow, where the licence is stated, not from the mirror that lost it.

> **A mirror cannot grant a licence, and an ambiguous restatement of one is not
> the licence. Always go to the page that declares it.**

Also excluded: **SH17**, the best-known PPE dataset — CC BY-**NC**-SA 4.0, so
the non-commercial clause forbids it.

Acceptable: MIT / Apache-2.0 / CC0 / public domain (no strings); CC BY 4.0
(commercial OK, attribution required — ship a [NOTICE](../NOTICE) entry).
Not acceptable: anything CC BY-NC or CC BY-NC-SA.

To add data: check the licence badge yourself, export COCO, upload as a Kaggle
Dataset, and add its path to `DATASET_DIRS`.

---

## Running the trainer

1. New Kaggle Notebook.
2. Settings → **Accelerator = "GPU T4 ×2"**. Required — `DEVICES=2` does not
   *request* hardware; on a single T4 this silently runs at half speed and the
   epoch-budget estimate will be wrong.
3. Settings → **Internet = ON** (datasets download from HuggingFace).
4. Upload `train_ppe_rfdetr_kaggle.py`.
5. Run **one** cell:

   ```
   !python train_ppe_rfdetr_kaggle.py
   ```

   **Run it as a script, not by pasting the code into a cell.** Multi-GPU
   training uses DDP, which spawns worker processes — that works from a
   subprocess but hangs or crashes inside a notebook kernel.

6. **Watch the `[budget]` block** printed before training starts. It measures the
   real dataset and reports how many epochs fit the session. If it prints
   `*** WARNING: N epochs is NOT ENOUGH ***` it also prints the exact resolution
   to use instead — stop, edit that one constant, re-run. Doing this in the first
   minute costs nothing; discovering it at hour 11 has already cost two runs.

Output → `/kaggle/working/ppe_rfdetr/`:

| File | Use |
|---|---|
| `checkpoint_best_ema.pth` | the trained weights — **not** used at runtime |
| `*.onnx` | **download this**; the worker runs ONNX via onnxruntime |

Copy the `.onnx` to `models/ppe/weights/ppe_rfdetr.onnx`, then pin its checksum:

```bash
npx tsx server/modelRegistry.ts --record
```

### Measured per-class AP on the shipped model

```
vest 0.77 | person 0.63 | boots 0.59 | helmet 0.56
no_vest 0.41 | no_helmet 0.30 | no_boots 0.14
```

The negatives are much weaker, which is exactly why the runtime gives them a
**higher** confidence floor than the positives — a false `no_helmet` is a false
accusation against a worker.

---

## The dataset pipeline — `scripts/`

`scripts/run_pipeline.sh` is the full rebuild driver, logging each stage into
`train/*.log`:

```
fetch_public.py    ~14k public images from 3 sources, streamed (no multi-GB
                   full download), each source's classes mapped into our 9;
                   unmapped classes (goggles, mask) dropped
      ↓
build_bidjoe.py    ~6k more, chosen for gloves and negative examples
      ↓
extract_frames.py  site videos → 1 fps → pHash dedupe in one pass
      ↓
autolabel.py       pseudo-labels for the site frames
      ↓
merge_split.py     merge site + public → dataset/, deterministic 85/15 split
      ↓
train.py           (local CPU run) → locked/ppe_person_best.pt
      ↓
test_locked.py     sanity-check the locked model on a 1-minute clip
```

### `extract_frames.py` — 1 fps *and* perceptual dedupe, in one pass

The camera is fixed, so consecutive seconds look almost identical. Frames are
sampled at 1 fps and immediately dropped if their pHash is within
`HASH_DIST = 6` Hamming distance of any frame already kept. That caps the set at
a diverse few hundred images **without ever writing 14k junk files** to disk.

### `autolabel.py` — hybrid pseudo-labelling

Tuned for small, distant CCTV workers:

1. `yolo11n-pose` gives high-quality **person** boxes → class 0.
2. For each person, the PPE model runs on the **upscaled person crop** — much
   better on small gloves and boots than on the full frame — and the boxes are
   mapped back to full-frame coordinates.

These labels are noisy by nature. That is expected: they are a strong starting
point, and the CVAT pass corrects the hard cases.

> This script still uses Ultralytics. That is fine — it produces *labels*, not
> shipped weights. The AGPL constraint applies to models that ship.

### `merge_split.py`

Deterministic 85/15 split (`random.seed(42)`). Images with an empty label file
are kept as **background negatives**, but capped at `MAX_EMPTY_RATIO = 0.10` of
the set so they cannot dominate.

---

## The CVAT labelling loop

Human correction happens in CVAT at **`label.hyperspark.in`** — the shared
annotation platform used for every model in this project, not just PPE.

```bash
python train/make_task.py "PPE Site - Batch 2"
```

It creates a task under the PPE project from `train/site_cvat/obj_train_data`,
in jobs of 100 frames, and records which frames were used in
`cvat_used_frames.json` so the **next batch excludes them**. That manifest is
what makes this an active-learning loop rather than a repeated relabelling of
the same easy frames.

> ⚠️ `make_task.py` currently has the CVAT host, username and password
> **hard-coded**. Move them to environment variables before this file goes
> anywhere public, and rotate the password.

---

## Before spending GPU hours

Run [`scripts/audit_dataset.py`](../scripts/audit_dataset.py) on the merged
dataset. The fire model wasted ~9.5 hours reaching mAP50 0.574 because one
source contributed ~89% of the images and was pre-augmented (15,345 files from
~6,391 originals), so the model largely learned that source's augmentation.
Licence and image *count* had been verified; data *quality* had not.

---

## Directory contents

| Path | What |
|---|---|
| `train_ppe_rfdetr_kaggle.py` | the shipping trainer |
| `train_ppe_kaggle.py` | superseded YOLO11 trainer, reference only |
| `make_task.py` | create a CVAT batch, excluding already-labelled frames |
| `cvat_used_frames.json` | the exclusion manifest |
| `scripts/` | the dataset pipeline above |
| `dataset/data.yaml` | the class list; images/labels are git-ignored |
| `*.log`, `driver.out` | logs from the last pipeline run |
| `site_dedup/`, `site_cvat/`, `frames*/`, `public_*/` | git-ignored working sets |
