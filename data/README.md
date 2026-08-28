# `data/` — local footage and datasets

[← back to the root README](../README.md) · siblings: [train/](../train/README.md) · [train_vehicle/](../train_vehicle/README.md) · [models/](../models/README.md)

**Everything in this directory except this file is git-ignored**, and should
stay that way. It is ~6.7 GB of video on a working box and would be far larger
on a real site. Nothing here is required to build or run the platform — it is
input for training and for offline testing of the analytics modules.

---

## What is here

| Path | Size | What |
|---|---|---|
| `PPE FILES/` | ~5.3 GB | site NVR exports — the source footage for the PPE model. Two long channels (`NVR_ch13_*`, `NVR_ch2_*`), ~1h and ~3h |
| `PPE FILES-…zip` | ~1.4 GB | the original archive those were extracted from |
| `vechiledetection/` | ~53 MB | a short traffic clip used for offline vehicle-module checks |

Filenames of the NVR exports encode channel and time range:
`NVR_ch<channel>_main_<start>_<end>.mp4`. The `ch13` / `ch2` prefixes are the
same ones that appear throughout `train/site_dedup/`, so a frame can always be
traced back to its source recording.

---

## How it is used

**Training** — [`train/scripts/extract_frames.py`](../train/scripts/extract_frames.py)
reads `data/PPE FILES/*.mp4`, samples at 1 fps and immediately drops
near-duplicates by perceptual hash, producing a diverse few hundred frames
instead of tens of thousands of near-identical ones. Those go on through
auto-labelling, CVAT correction and the merge/split into `train/dataset/`.
See [train/README.md](../train/README.md).

**Offline module checks** — the modules that have a `run_video.py` can be pointed
straight at a file, which is how they are developed without a live camera:

```bash
cd models/vehicle
python run_video.py --video ../../data/vechiledetection/VID-20260802-WA0001.mp4 \
                    --fps 10 --line 0,620,478,620

cd models/face
python run_video.py --video <clip>.mp4 --fps 6   # also prints median/p90
                                                 # interocular distance
```

That face-module measurement is worth knowing about: measured on this repo's
traffic footage, faces are **8–11 px interocular**, which is unusable for
recognition by any model. Check placement before trusting any result — see
[models/face/README.md](../models/face/README.md).

---

## Why none of this is in git

`.gitignore` excludes `data/*` (with this README as the only exception), every
video extension, every archive extension, and every weight/checkpoint format.

- Video is large, binary and incompressible; a single push would be gigabytes,
  and git keeps every version forever.
- **This is site footage of real people.** It is personal data under India's
  DPDP Act 2023, and the faces in it are biometric data. It must not be pushed
  to a hosted remote, and it must not be included in a backup that is not
  covered by the same retention and consent terms as the deployment.

Datasets are re-fetched by the training scripts from their source
(HuggingFace for BMD-45, Roboflow for the fire sources) rather than vendored, so
the licence stays attached to the download.

---

## Adding data

- Site footage: drop it under a descriptive directory here. Nothing needs
  configuring — the extraction script globs `data/PPE FILES/*.mp4`; adjust its
  `VIDEOS` glob for a new source.
- Public datasets: **do not** copy them here. Add the source to the relevant
  trainer's source list, having read the licence **on the page that declares
  it** — see the licence discussion in [train/README.md](../train/README.md).
- Before spending GPU hours on any merged set, run
  [`scripts/audit_dataset.py`](../scripts/audit_dataset.py).
