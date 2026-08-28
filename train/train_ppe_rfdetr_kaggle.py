#!/usr/bin/env python3
# =============================================================================
#  PPE + PERSON detector — RF-DETR (Apache-2.0) — single-file Kaggle trainer
# =============================================================================
#  Replaces the YOLO11 version, which cannot ship commercially:
#    * models/ppe/ imports `ultralytics` at runtime (AGPL-3.0)
#    * the four weights/*.pt files are YOLO-trained, and Ultralytics' licence
#      covers "the training code AND THE MODELS PRODUCED BY THAT TRAINING CODE"
#    * yolo11n-pose.pt (the visibility stage) is the same problem
#  AGPL is free of charge, but its price is source disclosure: distributing it
#  entitles every recipient to the complete source of the whole application.
#
#  RF-DETR is Apache-2.0 — verified chain:
#    rfdetr code / RF-DETR N,S,M,L weights / DINOv2 backbone ... all Apache-2.0
#  *** NEVER use RFDETRXLarge / RFDETR2XLarge: PML-1.0, needs a paid Roboflow
#  *** plan. They are not even installed by `rfdetr[train]`.
#
#  ---------------------------------------------------------------------------
#  DATASET LICENSING — WHY THE OLD SOURCES WERE DROPPED
#  ---------------------------------------------------------------------------
#  The four datasets the old YOLO script auto-downloaded were checked against
#  the HuggingFace metadata and are NOT usable commercially:
#
#     hiennguyen9874/ppe-detection ........... no licence declared
#     hf-vision/hardhat ...................... no licence declared
#     BIDJOE/ppe-14classes ................... no licence declared
#     Francesco/construction-safety-gsnvb .... "cc" (variant unspecified)
#
#  *** CORRECTION on the last one ***
#  The HuggingFace MIRROR declares only an ambiguous "cc". The ROBOFLOW
#  ORIGINAL declares CC BY 4.0 explicitly:
#      https://universe.roboflow.com/roboflow-100/construction-safety-gsnvb
#  So the data IS usable commercially — take it from Roboflow, where the
#  licence is stated, not from the mirror that lost it. This is the general
#  rule: a mirror cannot grant a licence, and an ambiguous restatement of one
#  is not the licence. Always go to the page that declares it.
#
#  No declared licence means ALL RIGHTS RESERVED — you have no permission at
#  all, which is worse than a restrictive licence. Training on them would put
#  the same cloud over the new weights that AGPL puts over the old ones.
#
#  (Also excluded: SH17, the best-known PPE dataset — it is CC BY-NC-SA 4.0,
#   so the NC clause forbids commercial use.)
#
#  This script instead pulls only sources with a VERIFIED permissive licence —
#  see HF_YOLO_SOURCES below. Acceptable licences:
#     * MIT / Apache-2.0 / CC0 / Public Domain — commercial OK, no strings
#     * CC BY 4.0 — commercial OK, requires attribution (ship a NOTICE file)
#     * CC BY-NC / CC BY-NC-SA — NOT usable
#
#  To add more data, check the licence badge yourself, export COCO, upload as a
#  Kaggle Dataset, and put its path in DATASET_DIRS.
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN
#  ---------------------------------------------------------------------------
#  1. New Kaggle Notebook.
#  2. Settings -> Accelerator = "GPU T4 x2"   <-- REQUIRED.
#     DEVICES=2 does not request hardware. On a single T4 this silently runs at
#     half speed and the epoch-budget estimate will be wrong.
#  3. Settings -> Internet = ON  (the dataset downloads from HuggingFace).
#  4. Upload this file:  Notebook -> File -> Upload  (or +Add Data -> Upload).
#  5. Run ONE cell:
#
#         !python train_ppe_rfdetr_kaggle.py
#
#     RUN IT AS A SCRIPT, NOT BY PASTING THE CODE INTO A CELL. Multi-GPU
#     training uses DDP, which spawns worker processes; that works from a
#     subprocess but hangs or crashes when launched inside a notebook kernel.
#     `!python ...` is a subprocess, so it is fine.
#
#  6. WATCH THE [budget] BLOCK printed before training starts. It measures the
#     real dataset and tells you how many epochs fit the session. If it prints
#     "*** WARNING: N epochs is NOT ENOUGH ***" it also prints the exact
#     RESOLUTION to use instead — stop, edit that one constant, re-run. Doing
#     this in the first minute costs nothing; discovering it at hour 11 has
#     already cost two runs.
#
#  OUTPUT -> /kaggle/working/ppe_rfdetr/
#     checkpoint_best_ema.pth     the trained weights
#     rfdetr-small.onnx           <-- DOWNLOAD THIS ONE; the worker runs ONNX
#
#  If the session dies early, checkpoint_best_ema.pth is still written every
#  time the score improves, so the run is never a total loss.
# =============================================================================

import json
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict

# ------------------------------- CONFIG --------------------------------------
# Auto-downloaded sources whose licences I VERIFIED against the HuggingFace
# metadata. Unlike the old script's four sources (all "no licence declared"),
# these explicitly permit commercial use.
#
#   vikasaarna/roboflow-construction-ppe-fruwx
#       MIT — declared both in the HF tags and inside the dataset's own
#       data.yaml. 4,460 images, YOLO format, train/valid/test pre-split.
#       Classes: boots, helmet, "helmet on", "no boots", "no helmet",
#                "no vest", person, vest  -> covers 7 of our 9.
#
# Only `gloves` / `no_gloves` are missing. Add another permissively-licensed
# gloves dataset here, or drop those two classes from CLASSES (and from
# models/ppe/config.py) so the model is not asked to learn what it never saw.
HF_YOLO_SOURCES = [
    ("vikasaarna/roboflow-construction-ppe-fruwx", "MIT", "data"),
]

# ---------------------------------------------------------------------------
#  ROBOFLOW UNIVERSE SOURCES — the ones that carry `no_*` labels
# ---------------------------------------------------------------------------
#  These are the reason the negative classes can improve at all. Each declares
#  CC BY 4.0 on its Universe page: commercial use permitted, ATTRIBUTION
#  REQUIRED (they are added to the NOTICE file shipped with the product).
#
#  DOWNLOAD NEEDS A FREE API KEY. Unlike HuggingFace, Roboflow Universe does
#  not serve datasets anonymously. Get one at roboflow.com (free tier is
#  enough for this), then on Kaggle:
#      Add-ons -> Secrets -> add ROBOFLOW_API_KEY
#  or export it in the environment. With no key these are SKIPPED with a
#  warning and training proceeds on the MIT set alone — it will not fail.
#
#  (workspace, project, version, licence)
#  Licence and class counts below were read FIRST-HAND from the Roboflow API
#  (GET https://api.roboflow.com/<workspace>/<project>), not from a search
#  result or a mirror. All three report license = "CC BY 4.0".
#
#  VERSION CHOICE MATTERS. Several projects publish AUGMENTED versions with a
#  much larger image count (mosaic, flips, colour jitter) built from the same
#  source photos. Those inflate the count without adding information, and
#  RF-DETR applies its own augmentation during training — feeding pre-augmented
#  copies mostly teaches the model the augmentation. Always prefer the RAW
#  version even when a bigger one exists:
#      construction-site-safety  v30 = 717 RAW   (v27/v28 = 2801, augmented)
#      ppe-construction-detection v16 = 2926 raw (v12 = 7712, augmented)
# ###########################################################################
# ##  REMOVE THIS LINE BEFORE COMMITTING OR SHIPPING  ########################
# ##                                                                       ##
# ##  Hardcoded so the Kaggle run needs no Secrets setup. This file lives   ##
# ##  in the product repo, so the key travels with it — delete the line     ##
# ##  once training is done, and rotate the key at:                         ##
# ##      roboflow.com -> Settings -> API Keys -> Generate New Key          ##
# ###########################################################################
ROBOFLOW_API_KEY = "voHdj2XwXqhS3L5aNxXa"
# ###########################################################################

ROBOFLOW_SOURCES = [
    # 1,206 imgs | no-helmet 129, no-vest 892, helmet 2543, vest 1343, person 2817
    ("roboflow-100", "construction-safety-gsnvb", 2, "CC BY 4.0"),
    # 717 imgs (raw) | NO-Hardhat 402, NO-Safety Vest 582, Hardhat 575,
    #                  Safety Vest 424, Gloves 296, Person 1142
    ("roboflow-universe-projects", "construction-site-safety", 30, "CC BY 4.0"),
    # 2,926 imgs — THE BIG ONE for negatives:
    #   no_helmet 2474, no_vest 7477, helmet 11728, vest 5190, person 13817
    ("v2-wo7jr", "ppe-construction-detection-dataset-utu1c", 16, "CC BY 4.0"),
]

#  WHAT THIS ACTUALLY BUYS (summed from the three, verified via the API):
#      no_helmet : ~3,005 new annotations   (model had very few)
#      no_vest   : ~8,951 new annotations
#      no_boots  : ZERO — none of the three annotate missing boots at all
#      no_gloves : ZERO
#  So no_helmet and no_vest should improve substantially. no_boots (AP 0.14)
#  will NOT: no public CC-licensed source annotates it, and feet are the
#  hardest region on a typical CCTV mount. Fix that with your own labelled
#  footage or do not sell boot compliance.

# Extra COCO-format datasets you attach yourself (Kaggle Input). Each must
# contain train/_annotations.coco.json. CHECK THE LICENCE BADGE FIRST.
DATASET_DIRS = [
    # "/kaggle/input/your-extra-ppe-dataset",
]

# ---------------------------------------------------------------------------
#  DATASETS THAT CARRY THE `no_*` LABELS — the ones that actually matter
# ---------------------------------------------------------------------------
#  The shipped model's weak classes are no_boots (AP 0.14), no_helmet (0.30)
#  and no_vest (0.41). They are weak because only ONE small source carries
#  missing-PPE annotations.
#
#  DO NOT fix this by merging positive-only PPE datasets. In object detection
#  every unlabelled region trains as BACKGROUND, so an image containing a
#  bare-headed worker with no `no_helmet` box actively teaches the model
#  "bare head = background". Adding such data makes the negative classes WORSE
#  while improving helmet/vest, which are already the strongest.
#
#  Only merge sources that annotate MISSING PPE under a compatible taxonomy.
#  All three below declare CC BY 4.0 on the Roboflow page (commercial use OK,
#  attribution required — add each to the NOTICE file):
#
#    1. roboflow-100/construction-safety-gsnvb
#         classes: helmet, no-helmet, vest, no-vest, person
#         part of RF100 (Intel-sponsored benchmark)
#
#    2. roboflow-universe-projects/construction-site-safety
#         classes: Hardhat, NO-Hardhat, Safety Vest, NO-Safety Vest, Mask,
#                  NO-Mask, Person, Safety Cone, machinery, vehicle
#
#    3. v2-wo7jr/ppe-construction-detection-dataset-utu1c
#         classes: no_helmet, no_vest, person, vest
#
#  VERIFY THE LICENCE BADGE ON THE PAGE BEFORE DOWNLOADING. Roboflow is a
#  user-upload platform; a badge can change and a re-upload can lose it.
#  Screenshot it, record the version, and keep the sha256 of the export.
#
#  NOT usable:
#    ultralytics construction-ppe ..... AGPL-3.0 (has no_* classes, but the
#                                       licence is the whole reason we left
#                                       YOLO — do not reintroduce it)
#    SH17 ............................. CC BY-NC-SA 4.0 (NC = no commercial)
#    ThinkingHub / SteelBench ......... CC BY-NC 4.0
#    CHV (ZijianWang-ZW/PPE_detection). no licence declared
#    SHWD (njvisionpower) ............. repo is MIT and it has 111,514 bare
#                                       heads, but the images were "obtained
#                                       from Google or Baidu". A labeller
#                                       cannot license images they do not own,
#                                       so the MIT badge covers the repo, not
#                                       the underlying photographs. Same class
#                                       of provenance risk as an undeclared
#                                       licence. Left out deliberately.
# ---------------------------------------------------------------------------

MODEL_SIZE = "small"      # nano | small | medium | large   (Apache-2.0 only)

# ---------------------------------------------------------------------------
# RESOLUTION — the single most important setting for CCTV, and the one the
# first vehicle run got wrong.
#
# Measured head-to-head on the SAME BMD-45 val split:
#     YOLO11s   @ 960px, 51 epochs -> mAP50 0.8911   mAP50-95 0.7702
#     RF-DETR-S @ 512px, 19 epochs -> mAP50 0.8723   mAP50-95 0.7321
# That is not an architecture gap. RF-DETR ran at 28% of the pixels
# (512^2 = 262k vs 960^2 = 921k) and 37% of the epochs. PPE items — a helmet
# on a distant worker, gloves — are exactly the small objects 512px destroys.
#
# MUST be divisible by 32 — verified empirically, not from the docs: the
# backbone asserts "input shape divisible by 32" at the forward pass, and a bad
# value is accepted by the CONSTRUCTOR and only explodes once training starts.
# Valid: 512, 544, 576, ... 704, 736, 768, 800 ...
#
# 768 is the honest compromise: 2.25x the pixels of 512, while still leaving
# enough epochs inside Kaggle's 12-hour session. 960 would match YOLO exactly
# but at 3.5x the pixels you would get ~10 epochs, which is worse overall.
RESOLUTION = 768

# EPOCHS is an UPPER BOUND. plan_budget() below measures the real dataset and
# lowers it to whatever actually fits the session, so training ends by itself
# instead of being killed mid-epoch at the wall (which happened twice: the PPE
# YOLO run died at epoch 51, the vehicle RF-DETR run at epoch 19 of 40).
EPOCHS     = 40

# Kaggle kills the session at 12h. Leave headroom for dataset build + export.
TIME_BUDGET_HOURS = 10.5

# batch_size is PER DEVICE under DDP: effective = BATCH x ACCUM x DEVICES.
BATCH_SIZE = 4            # per GPU
GRAD_ACCUM = 2            # 4 x 2 x 2 devices = effective 16 (unchanged)
LR         = 1e-4

# fp16, not bf16: Kaggle's T4 is Turing and has no bf16 tensor cores, so
# RF-DETR's "auto" picks an emulated-and-slow path. See the vehicle trainer.
AMP_DTYPE  = "fp16"

# 2x T4. The vehicle run used 1 GPU and that alone cost ~2x wall-clock.
# Select "GPU T4 x2" in the Kaggle session settings or this silently runs on one.
DEVICES    = 2
EARLY_STOPPING = True
EARLY_STOPPING_PATIENCE = 10
VAL_RATIO  = 0.12         # used only if a source has no valid/ split

WORK  = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./ppe_rfdetr_build")
MERGED = os.path.join(WORK, "ppe_dataset")
OUT    = os.path.join(WORK, "ppe_rfdetr")

# Our 9-class schema — matches models/ppe/config.py so the runtime is unchanged.
CLASSES = ["person", "helmet", "no_helmet", "vest", "no_vest",
           "gloves", "no_gloves", "boots", "no_boots"]
CAT_ID = {n: i + 1 for i, n in enumerate(CLASSES)}   # COCO ids are 1-based

# Source class name -> our class. Keys are normalised (lowercase, alphanumeric
# only), so "NO-Hardhat", "no_hardhat" and "No Hardhat" all match. PPE datasets
# are wildly inconsistent in naming, which is why this map is deliberately wide.
NAME_MAP = {
    # person
    "person": "person", "worker": "person", "people": "person",
    # helmet present
    "helmet": "helmet", "hardhat": "helmet", "safetyhelmet": "helmet",
    "helmeton": "helmet",
    "hat": "helmet", "withhelmet": "helmet",
    # helmet absent
    "nohardhat": "no_helmet", "nohelmet": "no_helmet", "head": "no_helmet",
    "withouthelmet": "no_helmet", "nosafetyhelmet": "no_helmet",
    # vest
    "vest": "vest", "safetyvest": "vest", "reflectivevest": "vest",
    "highvisvest": "vest", "withvest": "vest",
    "novest": "no_vest", "nosafetyvest": "no_vest", "withoutvest": "no_vest",
    # gloves
    "gloves": "gloves", "glove": "gloves", "safetygloves": "gloves",
    "noglove": "no_gloves", "nogloves": "no_gloves",
    # boots
    "boots": "boots", "safetyshoe": "boots", "safetyshoes": "boots",
    "shoes": "boots", "safetyboots": "boots",
    "noboots": "no_boots", "noshoes": "no_boots", "nosafetyshoe": "no_boots",
    "nobelt": None,
}


def fetch_roboflow(work_root: str) -> list[str]:
    """Download the Roboflow Universe sources in COCO format.

    Returns the list of downloaded dataset directories. NEVER raises: a missing
    key or a moved project must not destroy an otherwise valid training run, so
    every failure is reported and skipped.
    """
    # Order: the hardcoded constant above, then env, then Kaggle Secrets.
    # Delete the constant and this branch falls straight back to the secure path.
    key = (ROBOFLOW_API_KEY or "").strip()
    if not key:
        key = os.environ.get("ROBOFLOW_API_KEY", "").strip()
    if not key:
        try:                                    # Kaggle Secrets, if available
            from kaggle_secrets import UserSecretsClient
            key = UserSecretsClient().get_secret("ROBOFLOW_API_KEY")
        except Exception:                       # noqa: BLE001
            key = ""

    if not key:
        print("\n[roboflow] ROBOFLOW_API_KEY not set — SKIPPING the CC BY 4.0 sources.")
        print("[roboflow] Training will use the MIT dataset only, which means the")
        print("[roboflow] no_helmet / no_vest / no_boots classes will stay weak.")
        print("[roboflow] Free key: roboflow.com -> Settings -> API Key, then add it as")
        print("[roboflow] a Kaggle Secret named ROBOFLOW_API_KEY.\n")
        return []

    try:
        import roboflow  # noqa: F401
    except ImportError:
        sh(sys.executable, "-m", "pip", "install", "-q", "roboflow")

    from roboflow import Roboflow
    rf = Roboflow(api_key=key)

    out_dirs = []
    for workspace, project, version, licence in ROBOFLOW_SOURCES:
        dest = os.path.join(work_root, f"rf_{project[:28]}")
        if os.path.isdir(dest) and os.listdir(dest):
            print(f"[roboflow] {project} already downloaded — reusing")
            out_dirs.append(dest)
            continue
        try:
            print(f"[roboflow] fetching {workspace}/{project} v{version}  ({licence})")
            ds = (rf.workspace(workspace)
                    .project(project)
                    .version(version)
                    .download("coco", location=dest, overwrite=False))
            out_dirs.append(ds.location if hasattr(ds, "location") else dest)
        except Exception as e:                  # noqa: BLE001
            # A project can be renamed, re-versioned or made private at any
            # time. Name it clearly and carry on rather than aborting.
            print(f"[roboflow] FAILED {workspace}/{project} v{version}: {type(e).__name__}: {e}")
            print(f"[roboflow] skipping it — check the project still exists and is public")
    return out_dirs


def sh(*a):
    print("+", " ".join(a), flush=True)
    subprocess.check_call(a)


def ensure_deps():
    try:
        import rfdetr  # noqa: F401
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q", "rfdetr[train]")
    try:
        import PIL  # noqa: F401
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q", "pillow")
    try:
        import yaml, huggingface_hub  # noqa: F401
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q", "pyyaml", "huggingface_hub")


def norm(s):
    return "".join(c for c in str(s).lower() if c.isalnum())


def find_splits(root):
    """Return {split_name: dir} for any COCO splits present under `root`."""
    out = {}
    for cand in ("train", "valid", "val", "test"):
        d = os.path.join(root, cand)
        if os.path.exists(os.path.join(d, "_annotations.coco.json")):
            out["valid" if cand in ("valid", "val") else cand] = d
    # Some exports put a single split at the root.
    if not out and os.path.exists(os.path.join(root, "_annotations.coco.json")):
        out["train"] = root
    return out


def fetch_hf_yolo_sources():
    """Download the verified-licence YOLO datasets and convert them to COCO.

    Returns a list of COCO roots to merge. YOLO labels are class-INDEX based, so
    the source's data.yaml order is what defines each id — the index must be
    resolved to a NAME before remapping, or every label silently shifts.
    """
    if not HF_YOLO_SOURCES:
        return []
    import time
    from huggingface_hub import snapshot_download
    from PIL import Image
    import yaml as _yaml

    def snapshot_with_retry(repo, tries=10):
        """snapshot_download raises on HTTP 429 instead of backing off, and a
        dataset this size WILL be rate-limited on an unauthenticated request.
        It resumes from the local cache, so retrying continues where it stopped
        rather than restarting — without this the whole run dies at ~30%."""
        for i in range(tries):
            try:
                return snapshot_download(repo, repo_type="dataset", max_workers=4)
            except Exception as e:
                if i == tries - 1:
                    raise
                wait = min(120, 15 * (2 ** min(i, 3)))
                print(f"[fetch] interrupted ({type(e).__name__}) — resuming in {wait}s "
                      f"[{i + 1}/{tries}]", flush=True)
                time.sleep(wait)

    roots = []
    for repo, licence, subdir in HF_YOLO_SOURCES:
        print(f"\n[fetch] {repo}  (licence: {licence})")
        local = snapshot_with_retry(repo)
        base = os.path.join(local, subdir) if subdir else local

        ypath = next((os.path.join(base, f) for f in ("data.yaml", "data.yml")
                      if os.path.exists(os.path.join(base, f))), None)
        if not ypath:
            print(f"[fetch] !! no data.yaml under {base} — skipping")
            continue
        names = _yaml.safe_load(open(ypath))["names"]
        print(f"[fetch] source classes: {names}")

        out_root = os.path.join(WORK, "hf_" + repo.split("/")[-1][:24])
        for split in ("train", "valid"):
            src_img = os.path.join(base, split, "images")
            src_lbl = os.path.join(base, split, "labels")
            if not os.path.isdir(src_img):
                continue
            dst = os.path.join(out_root, split)
            os.makedirs(dst, exist_ok=True)

            images, anns = [], []
            iid, aid = 1, 1
            for fn in sorted(os.listdir(src_img)):
                if not fn.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue
                ip = os.path.join(src_img, fn)
                lp = os.path.join(src_lbl, os.path.splitext(fn)[0] + ".txt")
                if not os.path.exists(lp):
                    continue
                try:
                    with Image.open(ip) as im:
                        W, H = im.size
                except Exception:
                    continue

                rows = []
                for line in open(lp):
                    p = line.split()
                    if len(p) < 5:
                        continue
                    idx = int(p[0])
                    if idx >= len(names):
                        continue
                    tgt = NAME_MAP.get(norm(names[idx]))
                    if not tgt:
                        continue
                    cx, cy, w, h = (float(v) for v in p[1:5])
                    # YOLO is normalised centre/size; COCO is absolute top-left.
                    x = (cx - w / 2) * W
                    y = (cy - h / 2) * H
                    bw, bh = w * W, h * H
                    if bw <= 1 or bh <= 1:
                        continue
                    rows.append((tgt, [round(max(0.0, x), 2), round(max(0.0, y), 2),
                                       round(bw, 2), round(bh, 2)]))
                if not rows:
                    continue

                shutil.copy(ip, os.path.join(dst, fn))
                images.append({"id": iid, "file_name": fn, "width": W, "height": H})
                for tgt, bb in rows:
                    anns.append({"id": aid, "image_id": iid,
                                 "category_id": CAT_ID[tgt], "bbox": bb,
                                 "area": round(bb[2] * bb[3], 2), "iscrowd": 0})
                    aid += 1
                iid += 1

            with open(os.path.join(dst, "_annotations.coco.json"), "w") as f:
                json.dump({
                    "info": {"description": f"{repo} ({licence})", "version": "1.0"},
                    "licenses": [{"name": licence}], "images": images,
                    "categories": [{"id": CAT_ID[n], "name": n} for n in CLASSES],
                    "annotations": anns,
                }, f)
            print(f"[fetch]   {split}: {len(images)} images, {len(anns)} boxes")
        roots.append(out_root)
    return roots


def merge_datasets():
    """Merge every source COCO dataset into one, remapped to our 9 classes."""
    sources = fetch_hf_yolo_sources() + list(DATASET_DIRS)
    if not sources:
        sys.exit(
            "No dataset sources.\n"
            "Either keep HF_YOLO_SOURCES populated, or attach a LICENCE-CHECKED\n"
            "PPE dataset (COCO export) as a Kaggle Input and set DATASET_DIRS.\n"
            "See this file's header for which licences are acceptable."
        )
    globals()["DATASET_DIRS"] = sources

    for split in ("train", "valid"):
        os.makedirs(os.path.join(MERGED, split), exist_ok=True)

    acc = {s: {"images": [], "annotations": []} for s in ("train", "valid")}
    next_img, next_ann = [1], [1]
    unmapped = Counter()
    kept = Counter()

    for root in DATASET_DIRS:
        if not os.path.isdir(root):
            print(f"[merge] !! missing dataset dir: {root}")
            continue
        splits = find_splits(root)
        if not splits:
            print(f"[merge] !! no COCO splits under {root} — expected "
                  f"train/_annotations.coco.json")
            continue
        print(f"\n[merge] {root}  splits={list(splits)}")

        for split, sdir in splits.items():
            if split == "test":
                continue  # not used for training
            coco = json.load(open(os.path.join(sdir, "_annotations.coco.json")))
            id2name = {c["id"]: c["name"] for c in coco["categories"]}

            # Report what this source calls things, so a silently-dropped class
            # is impossible to miss.
            mapped = {n: NAME_MAP.get(norm(n)) for n in id2name.values()}
            print(f"   {split}: classes -> "
                  f"{ {k: (v or 'DROPPED') for k, v in mapped.items()} }")
            for n, v in mapped.items():
                if v is None:
                    unmapped[n] += 1

            by_img = defaultdict(list)
            for a in coco["annotations"]:
                tgt = NAME_MAP.get(norm(id2name.get(a["category_id"], "")))
                if tgt:
                    by_img[a["image_id"]].append((tgt, a["bbox"]))

            tag = os.path.basename(root.rstrip("/"))[:16]
            for im in coco["images"]:
                anns = by_img.get(im["id"])
                if not anns:
                    continue
                src = os.path.join(sdir, im["file_name"])
                if not os.path.exists(src):
                    continue
                new_name = f"{tag}_{split}_{next_img[0]}.jpg"
                shutil.copy(src, os.path.join(MERGED, split, new_name))
                acc[split]["images"].append({
                    "id": next_img[0], "file_name": new_name,
                    "width": im["width"], "height": im["height"],
                })
                for tgt, bb in anns:
                    x, y, w, h = bb
                    if w <= 1 or h <= 1:
                        continue
                    acc[split]["annotations"].append({
                        "id": next_ann[0], "image_id": next_img[0],
                        "category_id": CAT_ID[tgt],
                        "bbox": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
                        "area": round(w * h, 2), "iscrowd": 0,
                    })
                    kept[tgt] += 1
                    next_ann[0] += 1
                next_img[0] += 1

    # If no source shipped a valid split, carve one out of train.
    if not acc["valid"]["images"] and acc["train"]["images"]:
        import random
        random.seed(42)
        imgs = acc["train"]["images"][:]
        random.shuffle(imgs)
        n_val = int(len(imgs) * VAL_RATIO)
        val_ids = {im["id"] for im in imgs[:n_val]}
        print(f"\n[merge] no valid/ split found — holding out {n_val} images")
        acc["valid"]["images"] = [im for im in acc["train"]["images"] if im["id"] in val_ids]
        acc["train"]["images"] = [im for im in acc["train"]["images"] if im["id"] not in val_ids]
        acc["valid"]["annotations"] = [a for a in acc["train"]["annotations"] if a["image_id"] in val_ids]
        acc["train"]["annotations"] = [a for a in acc["train"]["annotations"] if a["image_id"] not in val_ids]
        for im in acc["valid"]["images"]:
            shutil.move(os.path.join(MERGED, "train", im["file_name"]),
                        os.path.join(MERGED, "valid", im["file_name"]))

    cats = [{"id": CAT_ID[n], "name": n, "supercategory": "ppe"} for n in CLASSES]
    for split in ("train", "valid"):
        with open(os.path.join(MERGED, split, "_annotations.coco.json"), "w") as f:
            json.dump({
                "info": {"description": "Merged PPE dataset (9 classes)", "version": "1.0"},
                "licenses": [], "images": acc[split]["images"],
                "categories": cats, "annotations": acc[split]["annotations"],
            }, f)
        print(f"[merge] {split}: {len(acc[split]['images'])} images, "
              f"{len(acc[split]['annotations'])} boxes")

    print(f"\n[merge] kept per class: {dict(kept)}")
    if unmapped:
        print(f"[merge] UNMAPPED source classes (add to NAME_MAP if needed): "
              f"{dict(unmapped)}")
    missing = [c for c in CLASSES if kept[c] == 0]
    if missing:
        print(f"[merge] WARNING: no examples for {missing} — the model cannot "
              f"learn them. Add a dataset that covers these, or drop them from "
              f"CLASSES and from models/ppe/config.py.")


def verify():
    ok = True
    for split in ("train", "valid"):
        d = os.path.join(MERGED, split)
        ann = os.path.join(d, "_annotations.coco.json")
        if not os.path.exists(ann):
            print(f"[check] MISSING {ann}")
            ok = False
            continue
        j = json.load(open(ann))
        miss = sum(1 for im in j["images"][:50]
                   if not os.path.exists(os.path.join(d, im["file_name"])))
        print(f"[check] {split}: {len(j['images'])} images, "
              f"{len(j['annotations'])} boxes, {miss}/50 sampled files missing")
        if not j["images"] or not j["annotations"] or miss:
            ok = False
    if not ok:
        sys.exit("[check] dataset invalid — aborting before training")


# Measured on the vehicle run so the estimate is grounded in this exact stack
# (RF-DETR Small, fp16, T4, batch 4/GPU): 20,000 images at 512px on ONE T4 took
# 31.7 min/epoch => 0.095 GPU-seconds per image per epoch.
SEC_PER_IMAGE_AT_512_PER_GPU = 0.095
DDP_EFFICIENCY = 0.95      # 2 GPUs give ~1.9x, not 2.0x

# Below this, resolution is the wrong thing to be spending the budget on.
MIN_USEFUL_EPOCHS = 20


def plan_budget(n_train_images: int) -> int:
    """Estimate epoch time and return the number of epochs that actually fit.

    Exists because guessing has now cost two runs. The estimate is deliberately
    conservative: it is better to finish 18 planned epochs and export cleanly
    than to be killed at epoch 19 of 40 with no ONNX.
    """
    pixel_factor = (RESOLUTION / 512.0) ** 2
    per_epoch_s = (SEC_PER_IMAGE_AT_512_PER_GPU * n_train_images * pixel_factor
                   / max(1, DEVICES) / DDP_EFFICIENCY)
    budget_s = TIME_BUDGET_HOURS * 3600.0
    fits = max(1, int(budget_s // per_epoch_s))
    planned = min(EPOCHS, fits)

    print("\n" + "=" * 68)
    print(f"[budget] train images        : {n_train_images:,}")
    print(f"[budget] resolution          : {RESOLUTION}px  ({pixel_factor:.2f}x the pixels of 512)")
    print(f"[budget] devices             : {DEVICES}")
    print(f"[budget] estimated per epoch : {per_epoch_s/60:.1f} min")
    print(f"[budget] time budget         : {TIME_BUDGET_HOURS} h  -> {fits} epochs fit")
    print(f"[budget] EPOCHS requested    : {EPOCHS}")
    print(f"[budget] TRAINING            : {planned} epochs "
          f"(~{planned*per_epoch_s/3600:.1f} h)")
    if planned < EPOCHS:
        print(f"[budget] NOTE: capped from {EPOCHS} to {planned} so the run ENDS on its own")
        print(f"[budget]       rather than being killed at the 12h wall mid-epoch.")

    # Resolution and epochs both buy accuracy, and here they compete for the
    # same 12 hours. Below ~20 epochs the model is undertrained no matter how
    # sharp the input: the vehicle run reached only 19 epochs and was still
    # climbing when it died. So if the plan is epoch-starved, say so and give
    # the exact resolution that fixes it rather than leaving it to be discovered
    # 10 hours later.
    if planned < MIN_USEFUL_EPOCHS:
        target_per_epoch = budget_s / MIN_USEFUL_EPOCHS
        ratio = target_per_epoch * DEVICES * DDP_EFFICIENCY / (
            SEC_PER_IMAGE_AT_512_PER_GPU * n_train_images)
        suggested = int((512 * (ratio ** 0.5)) // 32 * 32)   # must divide by 32
        print(f"[budget] ")
        print(f"[budget] *** WARNING: {planned} epochs is NOT ENOUGH. ***")
        print(f"[budget] Under ~{MIN_USEFUL_EPOCHS} epochs the model is undertrained whatever the")
        print(f"[budget] resolution — the vehicle run stalled at 19 and was still improving.")
        if suggested >= 512:
            print(f"[budget] FIX: set RESOLUTION = {suggested}  -> about {MIN_USEFUL_EPOCHS} epochs")
        else:
            print(f"[budget] FIX: this dataset is too large for {TIME_BUDGET_HOURS}h at any useful")
            print(f"[budget]      resolution. Cap it to ~{int(n_train_images * (512/RESOLUTION)**2 / 2):,} images,")
            print(f"[budget]      or train across two sessions with resume.")
        print(f"[budget] Edit the constant and re-run — do not train as-is.")
    print("=" * 68 + "\n")
    return planned


def count_train_images() -> int:
    ann = os.path.join(MERGED, "train", "_annotations.coco.json")
    with open(ann) as f:
        return len(json.load(f)["images"])


def train():
    import rfdetr
    cls = {"nano": "RFDETRNano", "small": "RFDETRSmall",
           "medium": "RFDETRMedium", "large": "RFDETRLarge"}[MODEL_SIZE]

    planned_epochs = plan_budget(count_train_images())

    eff = BATCH_SIZE * GRAD_ACCUM * DEVICES
    print(f"[train] {cls} @ {RESOLUTION}px  epochs={planned_epochs}  "
          f"batch {BATCH_SIZE}/gpu x accum {GRAD_ACCUM} x {DEVICES} gpu = effective {eff}  lr={LR}")

    # resolution must be passed to the CONSTRUCTOR, not train() — it changes the
    # positional-encoding size, which is baked into the model at build time.
    model = getattr(rfdetr, cls)(resolution=RESOLUTION)
    model.train(dataset_dir=MERGED, epochs=planned_epochs, batch_size=BATCH_SIZE,
                grad_accum_steps=GRAD_ACCUM, lr=LR, output_dir=OUT,
                amp_dtype=AMP_DTYPE, devices=DEVICES,
                early_stopping=EARLY_STOPPING,
                early_stopping_patience=EARLY_STOPPING_PATIENCE)

    print(f"\n[done] checkpoints in {OUT}")
    for f in ("checkpoint_best_ema.pth", "checkpoint_best_regular.pth"):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            print(f"   {f}  {os.path.getsize(p)/1e6:.1f} MB")
    print("[done] ship checkpoint_best_ema.pth")

    export_onnx(model)


def export_onnx(trained_model=None) -> None:
    """Export the best EMA checkpoint to ONNX, in the SAME session.

    The runtime is onnxruntime, not PyTorch — models/ppe/pipeline loads a .onnx
    and never touches the .pth. Exporting here rather than later matters
    because the rfdetr + torch stack is already installed and correct in this
    session; reproducing it locally means a multi-GB torch install just to run
    a converter once.

    Non-fatal on failure: the .pth is already saved, and an export can be redone
    offline. Losing the checkpoint to a crashed export step would not be
    recoverable, so this never raises.
    """
    import rfdetr
    ck = os.path.join(OUT, "checkpoint_best_ema.pth")
    if not os.path.exists(ck):
        print("[export] no checkpoint_best_ema.pth — skipping ONNX export")
        return
    # Resolved OUTSIDE the try: the except block prints it, and a bad MODEL_SIZE
    # would otherwise raise NameError there and hide the real failure.
    cls = {"nano": "RFDETRNano", "small": "RFDETRSmall",
           "medium": "RFDETRMedium", "large": "RFDETRLarge"}[MODEL_SIZE]
    try:
        # Rebuild from the checkpoint at the SAME resolution it was trained at.
        # A mismatch here silently produces a model whose positional encodings
        # do not match its weights.
        m = getattr(rfdetr, cls)(pretrain_weights=ck, num_classes=len(CLASSES),
                                 resolution=RESOLUTION)
        out = m.export(output_dir=OUT, opset_version=17, verbose=False)
        print(f"[export] ONNX written: {out}")
        print(f"[export] input is {RESOLUTION}x{RESOLUTION} — models/ppe/config.py "
              f"reads this from the session, nothing to set by hand.")
        print("[export] DOWNLOAD THIS .onnx — it is what the worker runs.")
    except Exception as e:            # noqa: BLE001
        print(f"[export] ONNX export FAILED: {type(e).__name__}: {e}")
        print("[export] The .pth is still saved. Export it later with:")
        print(f"[export]   m = rfdetr.{cls}(pretrain_weights='checkpoint_best_ema.pth',")
        print(f"[export]                num_classes={len(CLASSES)}, resolution={RESOLUTION})")
        print("[export]   m.export(output_dir='.')")
    print("[done] If your dataset is CC BY 4.0, keep an attribution NOTICE file "
          "with the product — that is the licence's one obligation.")


def main():
    ensure_deps()
    os.makedirs(WORK, exist_ok=True)

    # Roboflow sources are appended to DATASET_DIRS, so merge_datasets() picks
    # them up through the existing COCO path — no second merge code path.
    for d in fetch_roboflow(WORK):
        if d and d not in DATASET_DIRS:
            DATASET_DIRS.append(d)

    merge_datasets()
    verify()
    train()


if __name__ == "__main__":
    main()
