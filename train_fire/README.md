# `train_fire/` — fire + smoke detector

[← back to the root README](../README.md) · siblings: [train/](../train/README.md) · [train_vehicle/](../train_vehicle/README.md) · [models/](../models/README.md)

> **Status: trainer only.** There is no `models/fire/` worker yet. This
> directory produces weights; nothing in the platform runs them. Wiring it up
> means creating a module in the same shape as the others
> ([models/README.md](../models/README.md) has the contract) and adding a
> `fire` entry to `MODULE_FEATURES` in [`shared/schema.ts`](../shared/schema.ts).

One self-contained Kaggle trainer: `train_fire_rfdetr_kaggle.py`. Two classes,
RF-DETR-Small, exported to ONNX.

---

## ⚠️ There is a live Roboflow API key hard-coded in this script

It sits under a banner that says to remove it before committing — and it was
committed anyway. **Rotate it** (roboflow.com → Settings → API Keys → Generate
New Key) and move it to `ROBOFLOW_API_KEY` in the environment or a Kaggle
Secret. The script already reads both of those; the literal is a leftover.

---

## Why fire and smoke are separate classes

Smoke almost always **precedes** visible flame, so smoke is the early warning
and fire is the confirmation. Collapsing them into one class throws away the
minutes that make the feature worth buying.

They also look nothing alike: flame is small, bright and high-contrast; smoke is
large, low-contrast and semi-transparent. That is why smoke scores lower and
will need its own confidence floor at runtime — the same per-class-threshold
reasoning the [vehicle](../models/vehicle/README.md) and
[PPE](../models/ppe/README.md) modules use.

---

## Data — four Roboflow sources, all CC BY 4.0

Licences and counts were read **first-hand from the Roboflow API**
(`GET https://api.roboflow.com/<ws>/<proj>`), not from a search result. CC BY 4.0
permits commercial use; its one obligation is attribution, discharged by
[NOTICE](../NOTICE).

| Workspace / project | Version | Images | Note |
|---|---|---|---|
| `middle-east-tech-university/fire-and-smoke-detection-hiwia` | v2 | 15,345 (fire 10,559 / smoke 9,096) | the backbone of the set — but only **6,391 project-level uniques** |
| `data2/fire-smoke-detection-ua3dm` | v1 | 855 | v1 == v2, both raw |
| `smoke-and-fire-detecttion/fire-dataset-kdtib` | v1 | 482 | fire only, no smoke |
| `mahmoud-9wyf6/fire-and-smoke-detection-sdgt9` | **v3** | 469 raw | v1 is the *augmented* one (1,888) — do not use it |

### Two version traps this table already avoids

**Versions were checked against the API, not assumed.** Two would have failed
silently:

- `hiwia` has **only v2**. A v1 request 404s, and it is the biggest source — the
  run would have quietly trained on a quarter of the data.
- `sdgt9`'s **v1 is the augmented one** (1,888) while **v3 is raw** (469). That
  is the opposite of the usual pattern, so "use the lowest version" is wrong
  too.

**Prefer raw over augmented.** RF-DETR augments during training; a pre-augmented
copy mostly teaches the model the augmentation.

---

## The lesson this model taught the project

The first run spent **~9.5 hours to reach mAP50 0.574**. The cause was visible in
the data and nobody looked: `hiwia` contributed ~89% of the images and is
pre-augmented — 15,345 files from ~6,391 originals — so a big pre-augmented
source drowned the other three and the model largely learned its augmentation.

Licence and image *count* had been verified from the API. Data *quality* had not.
That gap is now closed by
[`scripts/audit_dataset.py`](../scripts/audit_dataset.py), which checks
duplicate/near-duplicate rates by perceptual hash, source balance, and box-size
distribution. **Run it on the merged dataset and read the verdict before
starting a run.**

---

## Configuration

| Constant | Value | Why |
|---|---|---|
| `MODEL_SIZE` | `"small"` | Nano/Small/Medium/Large only — **never** XLarge/2XLarge (PML-1.0, paid plan) |
| `RESOLUTION` | 640 | must be divisible by 32 — verified empirically, because the backbone asserts it at the **forward** pass, so a bad value is accepted by the constructor and only explodes once training starts. Fire and smoke are *large* regions, unlike a helmet on a distant worker, so this does not need the 768 the PPE model wanted |
| `EPOCHS` | 60 | an upper bound; `plan_budget()` lowers it to what fits |
| `TIME_BUDGET_HOURS` | 10.5 | Kaggle kills at 12h — leaves room for dataset build and export |
| `BATCH_SIZE` / `GRAD_ACCUM` | 4 per device / 2 | 4 × 2 × 2 GPUs = effective batch 16 |
| `LR` | 1e-4 | |
| `MIN_USEFUL_EPOCHS` | 25 | below this the `[budget]` block tells you the resolution to use instead |

---

## Run

1. New Kaggle Notebook.
2. Settings → **Accelerator = "GPU T4 ×2"**. Required — `DEVICES=2` does not
   *request* hardware; on one T4 this runs at half speed and the budget estimate
   is wrong.
3. Settings → **Internet = ON**.
4. Upload the file, then run **one** cell:

   ```
   !python train_fire_rfdetr_kaggle.py
   ```

   **As a script, not pasted into a cell.** Multi-GPU training uses DDP, which
   spawns worker processes — that works from a subprocess but hangs inside a
   notebook kernel.

5. **Read the `[budget]` block** before training starts. If it warns the epoch
   count is too low it prints the exact resolution to use instead. One minute now
   beats hour eleven.

Output → `/kaggle/working/fire_rfdetr/`:

| File | Use |
|---|---|
| `checkpoint_best_ema.pth` | trained weights — not used at runtime |
| `rfdetr-small.onnx` | **download this**; workers run ONNX (opset 17) |

The Roboflow fetch **never raises**: a missing key or a moved project prints
guidance instead of destroying a long run mid-way.

---

## If you build the worker

Follow [models/README.md](../models/README.md)'s contract and the nearest
existing module. Specific notes for fire:

- Give **smoke its own, lower confidence floor** than fire.
- Smoke is the early warning — emit it as its own event type, do not merge.
- A single frame must not raise a fire alarm. Use a hold time, the way
  [tamper](../models/tamper/README.md) does, not just a confidence threshold.
- Add `fire` to `MODULE_FEATURES`, add a migration if new columns are needed, and
  register its weight checksums in `models/manifest.json`.
