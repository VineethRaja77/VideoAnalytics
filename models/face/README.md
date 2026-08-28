# `models/face/` — face recognition

[← models/](../README.md) · [← root](../../README.md) · siblings: [ppe](../ppe/README.md) · [vehicle](../vehicle/README.md) · [person](../person/README.md) · [object](../object/README.md) · [tamper](../tamper/README.md)

Production module, same shape as `models/ppe/` and `models/vehicle/`.

```
frame ─▶ YuNet detect + align ─▶ quality gate (eye distance) ─▶ AuraFace embed
      ─▶ gallery match + threshold ─▶ IoU track ─▶ identity vote ─▶ event
```

## Nothing is trained here

This is architecturally different from PPE and vehicle, and the difference is the
whole reason "unknown" works.

PPE and vehicle are **closed-set classifiers**: fixed classes, softmax, always
returns one of them. Build face recognition that way — train a classifier over
your 50 employees — and a stranger *must* come out as one of those 50. That is
structural, not a tuning problem.

Here the embedder is **frozen**. It converts any face to a 512-d vector.
Recognition is nearest-neighbour search with an accept threshold; if nothing is
close enough the answer is `unknown`. Enrolling a person appends rows to a
gallery. Removing one deletes rows. **No GPU, no dataset, no training, no Kaggle.**

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt          # no torch — ONNX on CPU
cp .env.example .env
```

Enrol people — one folder per person, 3–5 images each:

```
people/
  ramesh/  a.jpg b.jpg c.jpg
  priya/   a.jpg b.jpg
```

```bash
python enroll.py --dir people/     # enrol
python enroll.py --list            # who is enrolled
python enroll.py --remove ramesh   # delete (instant, no retraining)
python worker.py                   # run against RTSP
python run_video.py --video clip.mp4 --fps 6      # offline check
```

Enrol using images **from the camera that will do the recognising**. Enrolling a
passport photo and matching it against an oblique CCTV view is the most common
cause of poor real-world accuracy.

## Models — both commercially licensed

| Component | Model | Licence | Size |
|---|---|---|---|
| Detection | YuNet (OpenCV Zoo) | **MIT** | 233 KB |
| Recognition | AuraFace `glintr100.onnx` (fal) | **Apache-2.0** | 261 MB |

### Provenance note — read before shipping

Only `glintr100.onnx` was taken from `fal/AuraFace-v1`. **The repo's other four
files (`scrfd_10g_bnkps`, `1k3d68`, `2d106det`, `genderage`) are identically named
to InsightFace antelopev2 components and are non-commercial.** Downloading the
whole repo and running the standard InsightFace pipeline would ship
non-commercial weights regardless of the Apache-2.0 label.

Verified locally — the recognition weights are **not** a byte copy of InsightFace's:

```
InsightFace antelopev2 glintr100.onnx  sha256 4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf
AuraFace (this file)   glintr100.onnx  sha256 a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60
```

However: a different hash proves it is not a copy, **not** that it was trained
independently — a fine-tune or re-export would also differ. Three separate
provenance requests on the HF discussion have gone **unanswered since Sept 2025**.

For a commercial deployment: pin the revision, archive the hash above, and get
written confirmation from fal before shipping. `FACE_BACKEND` exists so swapping
to dlib (public domain, unambiguous, weaker) is a config change, not a rewrite.

## Camera placement decides whether this works at all

**More than the model does.** Interocular distance in pixels:

| Eye distance | Result |
|---|---|
| < 20 px | detection only — recognition impossible |
| ~40 px | works, moderate accuracy |
| **80+ px** | **reliable — target this** |

On QMUL-SurvFace (463K native surveillance faces averaging **24×20 px**) the best
models reach only **13.8% TPIR @ 10% FPIR**. Wide-angle traffic CCTV faces are not
recognisable by anyone's model, ours included.

Measured on this repo's own footage: faces in the traffic clip are **8–11 px**
interocular. That footage is unusable for recognition and no amount of tuning
changes it. **Face recognition needs its own cameras** — gate/turnstile mounted,
narrow FOV, roughly face height, people walking toward them. It cannot be bolted
onto the wide-angle poles doing vehicle detection.

`MIN_EYE_DISTANCE_PX` enforces this: faces below it are counted but never
assigned a name. `run_video.py` prints the median/p90 interocular distance of
your footage so you can check placement before trusting any result.

## How "unknown" is enforced

Two independent guards in `pipeline/gallery.py`:

1. **Threshold** — best cosine similarity below `MATCH_THRESHOLD` → `unknown`.
2. **Margin** — best must beat the runner-up by `MATCH_MARGIN`, else `unknown`.
   Being unsure between two people is not a reason to pick one.

Then `pipeline/temporal.py` votes per track: similarity-weighted, locks after
`VOTE_LOCK_FRAMES` at ≥60% share. `unknown` votes participate, so a genuinely
unenrolled person converges on `unknown` rather than eventually being captured by
whichever enrolled face they drifted closest to once.

Scores are per-**person** (max over their images), so somebody enrolled with 5
photos does not out-vote somebody with 3.

### Tune the threshold — do not trust the default

`MATCH_THRESHOLD=0.40` is a starting point, not an answer. Measure on your own
people plus a set of strangers, and report both error directions:

- **FPIR** — strangers wrongly matched to an employee. Raise the threshold.
- **FNIR** — employees reported unknown. Lower it.

Which one you optimise is a business decision (door unlock vs. watchlist).

## Verified

Embedder validated on this machine:

| Check | Result |
|---|---|
| Determinism (same crop ×2) | 1.000000 |
| L2 normalisation | 1.000000 |
| Same face, +15% brightness | 0.9849 |
| Same face, blurred | 0.9954 |
| Different faces (190 pairs) | mean 0.187, max 0.584 |
| Batch vs single consistency | 1.000000 |

Same face ≈ 0.98 vs different ≈ 0.19 — clean separation around 0.40.

Two caveats on that table: the test crops came from 8–11 px faces (all this
footage offers), so the `max 0.584` is probably a genuine same-person pair from
consecutive frames rather than a false positive. And onnxruntime logs a benign
shape-inference warning on batched calls — batch output was verified identical to
single-image output (1.000000).

## Pipeline internals

Five stages, `pipeline/`:

### 1. `detect.py` — YuNet detection **and alignment**

Alignment is not optional. ArcFace-family embedders are trained on faces warped
to a fixed 112×112 canonical layout via 5 landmarks; feeding a raw crop instead
degrades similarity badly, and the damage is worst on exactly the off-angle
faces CCTV produces.

YuNet returns the 5 points needed (right eye, left eye, nose, right mouth, left
mouth — "right" meaning the subject's right, which appears on the image's left),
in the same order as the canonical `ARCFACE_REF`, so the mapping is 1:1 and
alignment is nearly free.

### 2. `embed.py` — the frozen embedder

Aligned 112×112 BGR → 512-d vector. ArcFace preprocessing convention is
`(pixel − 127.5) / 127.5` on **RGB**. Getting this wrong silently degrades
similarity rather than erroring, so it is written out explicitly rather than
inlined.

`FACE_BACKEND` selects the implementation. It exists so a licence problem with
AuraFace is a config change, not a rewrite — dlib (public domain, unambiguous,
weaker) is the fallback path.

### 3. `gallery.py` — the open-set decision

Stored as `gallery/gallery.npz`: a `(N, 512)` float32 array plus a parallel list
of names (a name repeats once per enrolled image), with a sidecar `.json` for
metadata. Enrolling appends rows; removing deletes them. That is the entire
"training" story.

Matching is cosine similarity, and scores are aggregated **per person** (max
over their images) before comparison — otherwise somebody enrolled with 5 photos
would out-vote somebody with 3 purely by count.

### 4. `track.py` — greedy IoU association

YuNet has no built-in tracking (unlike the detectors used elsewhere), and the
identity voter needs a stable per-person handle across frames. Greedy IoU
matching at `IOU_MATCH=0.3` is sufficient for a gate camera where people move
predictably and faces are reasonably large.

It has **no appearance model**, so ids swap if two people cross directly over
each other. The rest of the pipeline is unaffected by an upgrade because it only
consumes track ids.

### 5. `temporal.py` — identity voting

Similarity-weighted votes per track, locking after `VOTE_LOCK_FRAMES` at ≥60%
share. `unknown` votes participate, so a genuinely unenrolled person converges on
`unknown` rather than eventually being captured by whichever enrolled face they
drifted closest to once.

## Privacy — DPDP Act 2023

Facial data is **biometric = sensitive personal data**. Required: explicit,
specific, freely-given consent captured at collection; purpose limitation (access
control ≠ employee monitoring — a second purpose needs fresh consent); documented
retention and auto-purge for raw images, embeddings and logs.

`SAVE_UNKNOWN_SNAPSHOTS` defaults to **false** — storing images of unidentified
people is the highest-risk artefact here. Enable only with a documented lawful
basis.

## Known gaps

- **Threshold not tuned** — needs your people + a stranger set.
- **dlib backend not wired** — `build_embedder` raises with instructions.
  (Reminder: dlib's 68-point landmark model is *not* commercially free; use the
  5-point one.)
- **IoU tracking only** — no appearance re-ID, so ids can swap if two people
  cross directly over each other. Fine for a gate camera.
- **No liveness / anti-spoofing** — a printed photo will match. Add PAD before
  using this for access control.
