#!/usr/bin/env python3
# =============================================================================
#  VEHICLE TYPE detector — RF-DETR (Apache-2.0) — single-file Kaggle trainer
# =============================================================================
#  Replaces the YOLO11 version. Reason: Ultralytics YOLO is AGPL-3.0 and their
#  licence explicitly covers "the training code AND THE MODELS PRODUCED BY THAT
#  TRAINING CODE" — so YOLO-trained weights cannot ship in a closed-source
#  commercial product without an Enterprise Licence. RF-DETR is Apache-2.0.
#
#  VERIFIED LICENCE CHAIN (all free for commercial use):
#    rfdetr code ................ Apache-2.0
#    RF-DETR N/S/M/L weights .... Apache-2.0
#    DINOv2 backbone ............ Apache-2.0 (Meta relicensed Aug 2023)
#    BMD-45 dataset ............. CC BY 4.0 (verified on the HF dataset card)
#                                 Commercial use IS permitted. The one
#                                 obligation is ATTRIBUTION — ship a NOTICE
#                                 file naming BMD-45 (IISc AIM) with the
#                                 product. "public and ungated" describes
#                                 ACCESS, not a licence; do not confuse them.
#  *** DO NOT USE RFDETRXLarge / RFDETR2XLarge — those are PML-1.0 and need a
#  *** paid Roboflow platform plan. Nano..Large only.
#
#  8 classes: two_wheeler three_wheeler car van lcv truck bus bicycle
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN ON KAGGLE
#  ---------------------------------------------------------------------------
#  1. New Notebook -> Settings: Accelerator = GPU (T4 x2 or P100), Internet = ON
#  2. !python train_vehicle_rfdetr_kaggle.py
#  3. Model -> /kaggle/working/vehicle_rfdetr/checkpoint_best_ema.pth
#
#  SKIP THE 70 GB DOWNLOAD ON RE-RUNS
#  The first run spends ~40 min fetching BMD-45. Afterwards, zip
#  /kaggle/working/dataset and upload it as a Kaggle Dataset, then set
#  DATASET_DIR below to its input path — training then starts immediately.
# =============================================================================

import json
import os
import random
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

random.seed(42)

# ------------------------------- CONFIG --------------------------------------
# RFDETRNano / RFDETRSmall / RFDETRMedium / RFDETRLarge  <- Apache-2.0 only
MODEL_SIZE   = "small"

# 40, not 55. On ONE T4 with fp16 expect ~12-20 min/epoch, so 55 epochs is
# 11-18 h against Kaggle's 12 h cap — the same trap as before. Your YOLO run was
# already flat by epoch 40 (0.8910 -> 0.8906 at 51), so the extra epochs bought
# nothing. Raise this only if you switch DEVICES back to 2.
EPOCHS       = 40
# Effective batch = BATCH_SIZE x GRAD_ACCUM x DEVICES, because batch_size is
# PER DEVICE under Lightning's DDP. Roboflow recommends an effective batch of
# 16, so with two T4s that is 4 x 2 x 2 — not 4 x 4 x 2, which would silently
# train at 32 with a learning rate tuned for 16.
BATCH_SIZE   = 4            # per GPU
GRAD_ACCUM   = 2            # 4 x 2 x 2 devices = effective 16 (unchanged)

# ---------------------------------------------------------------------------
# RESOLUTION — the setting the first run got wrong.
#
# Measured head-to-head on the SAME BMD-45 val split:
#     YOLO11s   @ 960px, 51 epochs -> mAP50 0.8911  mAP50-95 0.7702
#     RF-DETR-S @ 512px, 19 epochs -> mAP50 0.8723  mAP50-95 0.7321
# That was not an architecture gap: RF-DETR ran at 28% of the pixels and 37%
# of the epochs. The weakest classes (truck 0.61, lcv 0.67) are exactly the
# ones that confuse at low resolution.
#
# MUST be divisible by 32 — verified empirically; the backbone asserts it at
# the FORWARD pass, so a bad value passes the constructor and dies in training.
# 640 rather than 768: this dataset is far larger than the PPE one, and
# plan_budget() below shows 768 would leave too few epochs.
RESOLUTION   = 640
LR           = 1e-4

# Stop early if val stops improving. Insurance against the 12 h Kaggle wall:
# the YOLO run was flat from epoch 40 (0.8910 -> 0.8906 by 51), so the last
# third of training bought nothing. best_ema is kept regardless.
EARLY_STOPPING = True
EARLY_STOPPING_PATIENCE = 10

# Mixed-precision dtype. MUST be "fp16" on a Kaggle T4.
#
# RF-DETR's "auto" asks torch.cuda.is_bf16_supported(), which returns True on a
# T4 because bf16 *runs* there — by emulation. But T4 is Turing (SM 7.5) and
# bf16 tensor cores only exist from Ampere (SM 8.0) onward, so "auto" picks a
# path that is several times slower than fp16. Measured effect: ~46 min/epoch
# on 20k images, i.e. 55 epochs would need ~42 h and never finish inside
# Kaggle's 12 h limit. Set "auto" only if you move to an A100/L4/newer GPU.
AMP_DTYPE    = "fp16"

# 1 = single GPU (safe: no DDP, no multi-process hangs).
# 2 = use both T4s for ~2x speed, but if it stalls right after "LOCAL_RANK: 0"
#     DDP is the cause — drop back to 1. If you set 2, also set GRAD_ACCUM=2 so
#     the effective batch stays 16 (batch_size is PER DEVICE).
DEVICES      = 2            # T4 x2. Select "GPU T4 x2" in Kaggle settings.

# Lowered from 20,000 to buy RESOLUTION and EPOCHS. The trade was made with
# the numbers in front of us:
#     20,000 @ 512px -> 19 epochs, mAP50 0.872 and ALREADY PLATEAUED
#                       (EMA gains over the last 3 epochs: +0.0039, +0.0003)
#     14,000 @ 640px -> ~24 epochs
# Epochs were not the binding constraint last time — resolution was. Feeding
# 6,000 fewer street images at 1.56x the pixels should help truck (AP 0.61) and
# lcv (0.67) more than the extra images would, because those two confuse with
# each other precisely at low resolution.
# Raise it back toward 35,792 only if you also drop RESOLUTION.
CAP_TRAIN    = 14000        # of 35,792 available
CAP_VAL      = 2500         # of 10,194

MAX_SIDE     = 1280         # images are re-encoded to this; boxes scale with them
JPEG_Q       = 88
DL_WORKERS   = 12

# Point at a pre-built dataset (e.g. an uploaded Kaggle Dataset) to skip fetching.
DATASET_DIR  = ""

WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./rfdetr_build")
DATA = DATASET_DIR or os.path.join(WORK, "dataset")
OUT  = os.path.join(WORK, "vehicle_rfdetr")
REPO = "iisc-aim/BMD-45"

# COCO category ids are 1-based (id 0 is conventionally background).
#  9th class: FORKLIFT. Warehouse and factory sites want forklift-near-person
#  alerts, and a forklift is just another vehicle to this detector — folding it
#  in here is far cheaper than a second model and a second worker process.
#  BMD-45 (Bengaluru street traffic) contains no forklifts, so the class comes
#  entirely from the CC BY 4.0 Roboflow sources appended after build_dataset().
CLASSES = ["two_wheeler", "three_wheeler", "car", "van", "lcv",
           "truck", "bus", "bicycle", "forklift"]
CAT_ID = {name: i + 1 for i, name in enumerate(CLASSES)}

# BMD-45's 13 real categories -> our 8. Matched by NAME, never by index, so a
# re-export that renumbers ids cannot silently corrupt every label.
BMD_TO_OURS = {
    "twowheeler":   "two_wheeler",
    "threewheeler": "three_wheeler",
    "hatchback": "car", "sedan": "car", "suv": "car", "muv": "car",
    "van": "van",
    "lcv": "lcv", "tempotraveller": "lcv",
    "truck": "truck",
    "bus": "bus", "minibus": "bus",
    "bicycle": "bicycle",
}


def sh(*args):
    print("+", " ".join(args), flush=True)
    subprocess.check_call(args)


def ensure_deps():
    try:
        import rfdetr  # noqa: F401
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q", "rfdetr[train]")
    try:
        import huggingface_hub, PIL  # noqa: F401
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q", "huggingface_hub", "pillow")


def norm_key(s):
    return "".join(c for c in str(s).lower() if c.isalnum())


# --------------------- rare-class-aware image selection ----------------------
def select_images(coco, cap, per_img):
    """Pick which images to fetch.

    Plain head-truncation starves the rare classes: `van` and `bicycle` are ~1%
    of boxes each, so a small cap can yield ZERO of them. Score each image by the
    inverse frequency of the classes it contains and take the richest first. On
    the YOLO run this captured 100% of van and 98% of bicycle boxes from only 56%
    of the images.
    """
    freq = Counter()
    for anns in per_img.values():
        for name, _ in anns:
            freq[name] += 1

    imgs = [im for im in coco["images"] if per_img.get(im["id"])]
    if cap >= len(imgs):
        random.shuffle(imgs)
        return imgs, freq

    total = sum(freq.values()) or 1
    w = {c: total / (n + 1.0) for c, n in freq.items()}

    def score(im):
        cs = {n for n, _ in per_img[im["id"]]}
        return sum(w.get(c, 0.0) for c in cs) * random.uniform(0.85, 1.15)

    imgs.sort(key=score, reverse=True)
    return imgs[:cap], freq


# --------------------- build the COCO dataset RF-DETR wants ------------------
def build_split(folder, split_dir, cap):
    """Fetch one BMD-45 split and write it as RF-DETR COCO.

    Layout (verified against RF-DETR's dataset-formats doc):
        <split_dir>/_annotations.coco.json
        <split_dir>/<image>.jpg            <- images live DIRECTLY here,
                                              NOT in an images/ subfolder
    """
    from huggingface_hub import hf_hub_download
    from PIL import Image

    os.makedirs(split_dir, exist_ok=True)
    ann_path = os.path.join(split_dir, "_annotations.coco.json")
    if os.path.exists(ann_path):
        print(f"[data] {split_dir} already built — skipping")
        return

    src = hf_hub_download(REPO, f"{folder}/_annotations.coco.json", repo_type="dataset")
    coco = json.load(open(src))
    id2name = {c["id"]: c["name"] for c in coco["categories"]}

    per_img = defaultdict(list)
    for a in coco["annotations"]:
        ours = BMD_TO_OURS.get(norm_key(id2name.get(a["category_id"], "")))
        if ours:
            per_img[a["image_id"]].append((ours, a["bbox"]))

    chosen, freq = select_images(coco, cap, per_img)
    print(f"[data] {folder}: {len(coco['images'])} available, taking {len(chosen)}")
    print(f"[data] full-split box counts: {dict(freq)}")

    out_images, out_anns = [], []
    next_ann_id = [1]
    failed = [0]

    def grab(im):
        rel = im["file_name"]                      # e.g. images_000/57.png
        base = f"bmd_{im['id']}.jpg"
        dst = os.path.join(split_dir, base)
        png = None
        try:
            if not os.path.exists(dst):
                png = hf_hub_download(REPO, f"{folder}/{rel}", repo_type="dataset")
                with Image.open(png) as p:
                    p = p.convert("RGB")
                    ow, oh = p.size
                    scale = 1.0
                    if max(p.size) > MAX_SIDE:
                        scale = MAX_SIDE / float(max(p.size))
                        p = p.resize((int(ow * scale), int(oh * scale)), Image.BILINEAR)
                    p.save(dst, quality=JPEG_Q)
                    nw, nh = p.size
            else:
                with Image.open(dst) as p:
                    nw, nh = p.size
                ow, oh = im["width"], im["height"]
                scale = nw / float(ow)

            return (im["id"], base, nw, nh, scale)
        except Exception as e:
            failed[0] += 1
            if failed[0] <= 5:
                print(f"   fetch fail {rel}: {type(e).__name__}")
            return None
        finally:
            # 2-5 MB PNGs; the full split is ~100 GB. Delete immediately.
            if png and os.path.exists(png):
                try:
                    os.remove(png)
                except Exception:
                    pass

    with ThreadPoolExecutor(max_workers=DL_WORKERS) as ex:
        results = list(ex.map(grab, chosen))

    for r in results:
        if not r:
            continue
        img_id, base, nw, nh, scale = r
        out_images.append({"id": img_id, "file_name": base, "width": nw, "height": nh})
        for name, bb in per_img[img_id]:
            # COCO bboxes are ABSOLUTE pixels, so a resized image REQUIRES the
            # boxes to be scaled too. (The YOLO format normalised them, which
            # hid this; getting it wrong here silently trains on shifted boxes.)
            x, y, w, h = (v * scale for v in bb)
            x = max(0.0, min(x, nw))
            y = max(0.0, min(y, nh))
            w = max(0.0, min(w, nw - x))
            h = max(0.0, min(h, nh - y))
            if w <= 1 or h <= 1:
                continue
            out_anns.append({
                "id": next_ann_id[0],
                "image_id": img_id,
                "category_id": CAT_ID[name],
                "bbox": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
                "area": round(w * h, 2),
                "iscrowd": 0,
            })
            next_ann_id[0] += 1

    with open(ann_path, "w") as f:
        json.dump({
            "info": {"description": "BMD-45 merged to 8 vehicle classes", "version": "1.0"},
            "licenses": [],
            "images": out_images,
            "categories": [{"id": CAT_ID[n], "name": n, "supercategory": "vehicle"}
                           for n in CLASSES],
            "annotations": out_anns,
        }, f)

    per_class = Counter(a["category_id"] for a in out_anns)
    inv = {v: k for k, v in CAT_ID.items()}
    print(f"[data] {split_dir}: {len(out_images)} images, {len(out_anns)} boxes "
          f"({failed[0]} fetch failures)")
    print(f"[data] class counts: { {inv[k]: v for k, v in sorted(per_class.items())} }")


def build_dataset():
    if DATASET_DIR:
        print(f"[data] using prebuilt dataset at {DATASET_DIR}")
        return
    build_split("BMD-45-Train", os.path.join(DATA, "train"), CAP_TRAIN)
    build_split("BMD-45-Val", os.path.join(DATA, "valid"), CAP_VAL)


def verify_dataset():
    """Fail fast on a malformed dataset rather than after hours of training."""
    ok = True
    for split in ("train", "valid"):
        d = os.path.join(DATA, split)
        ann = os.path.join(d, "_annotations.coco.json")
        if not os.path.exists(ann):
            print(f"[check] MISSING {ann}")
            ok = False
            continue
        j = json.load(open(ann))
        n_img, n_ann = len(j["images"]), len(j["annotations"])
        missing = sum(
            1 for im in j["images"][:50]
            if not os.path.exists(os.path.join(d, im["file_name"]))
        )
        print(f"[check] {split}: {n_img} images, {n_ann} boxes, "
              f"{len(j['categories'])} classes, {missing}/50 sampled files missing")
        if n_img == 0 or n_ann == 0 or missing:
            ok = False
    if not ok:
        sys.exit("[check] dataset invalid — aborting before training")


def train():
    import rfdetr

    cls = {
        "nano": "RFDETRNano",
        "small": "RFDETRSmall",
        "medium": "RFDETRMedium",
        "large": "RFDETRLarge",
    }[MODEL_SIZE]
    eff = BATCH_SIZE * GRAD_ACCUM * DEVICES
    print(f"\n[train] {cls}  epochs={EPOCHS}  amp={AMP_DTYPE}  devices={DEVICES}")
    print(f"[train] batch {BATCH_SIZE}/gpu x accum {GRAD_ACCUM} x {DEVICES} gpu "
          f"= effective {eff}  lr={LR}")

    with open(os.path.join(DATA, "train", "_annotations.coco.json")) as f:
        planned_epochs = plan_budget(len(json.load(f)["images"]))

    # resolution goes to the CONSTRUCTOR, not train(): it changes the positional
    # encoding size, which is baked into the model at build time.
    model = getattr(rfdetr, cls)(resolution=RESOLUTION)
    model.train(
        dataset_dir=DATA,
        epochs=planned_epochs,
        batch_size=BATCH_SIZE,
        grad_accum_steps=GRAD_ACCUM,
        lr=LR,
        output_dir=OUT,
        amp_dtype=AMP_DTYPE,   # fp16 on T4 — see the AMP_DTYPE note above
        devices=DEVICES,
        early_stopping=EARLY_STOPPING,
        early_stopping_patience=EARLY_STOPPING_PATIENCE,
    )

    print(f"\n[done] checkpoints in {OUT}")
    for f in ("checkpoint_best_ema.pth", "checkpoint_best_regular.pth", "last.ckpt"):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            print(f"   {f}  {os.path.getsize(p) / 1e6:.1f} MB")
    print("[done] ship checkpoint_best_ema.pth — EMA weights usually generalise best")


# ###########################################################################
# ##  REMOVE THIS LINE BEFORE COMMITTING OR SHIPPING  ########################
# ##  Rotate at roboflow.com -> Settings -> API Keys -> Generate New Key    ##
# ###########################################################################
ROBOFLOW_API_KEY = "voHdj2XwXqhS3L5aNxXa"
# ###########################################################################

#  Licence + version read FIRST-HAND from the Roboflow API. Prefer RAW over
#  augmented: RF-DETR augments during training, so pre-augmented copies mostly
#  teach the model the augmentation.
#  (workspace, project, version, licence)
FORKLIFT_SOURCES = [
    # v2 = 7,383 imgs, forklift 3,844   (v1 is only 1,000 — use v2)
    ("csv2tfrecord", "forklift-detection-koqxi", 2, "CC BY 4.0"),
    # v3 = 421 RAW at 640px | forklift 458, person 415
    # (v4/v5 = 1,011 are augmented). `person` is DROPPED here: this model has no
    # person class, and the person module already provides one.
    ("mohamed-traore-2ekkp", "forklift-dsitv", 3, "CC BY 4.0"),
]


# Measured on the FIRST vehicle run with this exact stack: 20,000 images at
# 512px on ONE T4 = 31.7 min/epoch.
SEC_PER_IMAGE_AT_512_PER_GPU = 0.095
DDP_EFFICIENCY = 0.95
TIME_BUDGET_HOURS = 10.5
MIN_USEFUL_EPOCHS = 20


def plan_budget(n_train_images: int) -> int:
    """Estimate epoch time and return the epochs that actually fit.

    Exists because guessing cost two runs: the PPE YOLO run died at epoch 51
    and the first vehicle run at epoch 19 of 40, both at the 12h wall.
    """
    pixel_factor = (RESOLUTION / 512.0) ** 2
    per_epoch = (SEC_PER_IMAGE_AT_512_PER_GPU * n_train_images * pixel_factor
                 / max(1, DEVICES) / DDP_EFFICIENCY)
    budget_s = TIME_BUDGET_HOURS * 3600.0
    fits = max(1, int(budget_s // per_epoch))
    planned = min(EPOCHS, fits)

    print("\n" + "=" * 68)
    print(f"[budget] train images        : {n_train_images:,}")
    print(f"[budget] resolution          : {RESOLUTION}px  ({pixel_factor:.2f}x the pixels of 512)")
    print(f"[budget] devices             : {DEVICES}")
    print(f"[budget] estimated per epoch : {per_epoch/60:.1f} min")
    print(f"[budget] time budget         : {TIME_BUDGET_HOURS} h -> {fits} epochs fit")
    print(f"[budget] TRAINING            : {planned} epochs (~{planned*per_epoch/3600:.1f} h)")
    if planned < EPOCHS:
        print(f"[budget] NOTE: capped from {EPOCHS} so the run ENDS on its own rather")
        print(f"[budget]       than being killed at the 12h wall mid-epoch.")
    if planned < MIN_USEFUL_EPOCHS:
        print(f"[budget]")
        print(f"[budget] *** WARNING: {planned} epochs is NOT ENOUGH. ***")
        print(f"[budget] Lower RESOLUTION to 576 or 512, or lower CAP_TRAIN")
        print(f"[budget] (currently {CAP_TRAIN}). Edit and re-run — do not train as-is.")
    print("=" * 68 + "\n")
    return planned


def append_roboflow_forklift():
    """Fold the CC BY 4.0 forklift datasets into the BMD-45 COCO already built.

    Appends rather than rebuilds: BMD-45 is 20k images that took ~40 min to
    fetch and re-encode, and redoing that to add one class would be wasteful.

    Non-fatal. Without a key, or if a project moved, the run continues as an
    8-class vehicle model — which is exactly what shipped before, so a forklift
    problem must never cost you the vehicle retrain.
    """
    key = (ROBOFLOW_API_KEY or "").strip() or os.environ.get("ROBOFLOW_API_KEY", "").strip()
    if not key:
        try:
            from kaggle_secrets import UserSecretsClient
            key = UserSecretsClient().get_secret("ROBOFLOW_API_KEY")
        except Exception:  # noqa: BLE001
            key = ""
    if not key:
        print("\n[forklift] no ROBOFLOW_API_KEY — skipping the forklift class.")
        print("[forklift] Training continues as an 8-class vehicle model.\n")
        return

    try:
        import roboflow  # noqa: F401
    except ImportError:
        sh(sys.executable, "-m", "pip", "install", "-q", "roboflow")
    from roboflow import Roboflow
    rf = Roboflow(api_key=key)

    def norm(x):
        return "".join(c for c in str(x).lower() if c.isalnum())

    added = 0
    for split in ("train", "valid"):
        ann_path = os.path.join(DATA, split, "_annotations.coco.json")
        if not os.path.exists(ann_path):
            continue
        coco = json.load(open(ann_path))
        next_img = max([i["id"] for i in coco["images"]] or [0]) + 1
        next_ann = max([a["id"] for a in coco["annotations"]] or [0]) + 1

        for ws, proj, ver, lic in FORKLIFT_SOURCES:
            dest = os.path.join(WORK, f"rf_{proj[:28]}")
            try:
                if not (os.path.isdir(dest) and os.listdir(dest)):
                    print(f"[forklift] fetching {ws}/{proj} v{ver} ({lic})")
                    rf.workspace(ws).project(proj).version(ver).download(
                        "coco", location=dest, overwrite=False)
            except Exception as e:  # noqa: BLE001
                print(f"[forklift] FAILED {ws}/{proj} v{ver}: {type(e).__name__}: {e}")
                continue

            sdir = os.path.join(dest, split)
            spath = os.path.join(sdir, "_annotations.coco.json")
            if not os.path.exists(spath):
                continue
            src = json.load(open(spath))
            id2name = {c["id"]: c["name"] for c in src["categories"]}

            by_img = {}
            for a in src["annotations"]:
                if norm(id2name.get(a["category_id"], "")) != "forklift":
                    continue          # person and placeholder rows are dropped
                by_img.setdefault(a["image_id"], []).append(a["bbox"])

            for im in src["images"]:
                boxes = by_img.get(im["id"])
                if not boxes:
                    continue
                sfile = os.path.join(sdir, im["file_name"])
                if not os.path.exists(sfile):
                    continue
                # Prefix with the project so two sources cannot collide on a
                # shared filename like "IMG_0001.jpg".
                fname = f"fk_{proj[:12]}_{im['id']}_{os.path.basename(im['file_name'])}"
                dfile = os.path.join(DATA, split, fname)
                if not os.path.exists(dfile):
                    try:
                        os.link(sfile, dfile)
                    except OSError:
                        shutil.copy2(sfile, dfile)

                coco["images"].append({
                    "id": next_img, "file_name": fname,
                    "width": im.get("width", 0), "height": im.get("height", 0),
                })
                for bb in boxes:
                    coco["annotations"].append({
                        "id": next_ann, "image_id": next_img,
                        "category_id": CAT_ID["forklift"],
                        "bbox": bb, "area": float(bb[2]) * float(bb[3]), "iscrowd": 0,
                    })
                    next_ann += 1
                    added += 1
                next_img += 1

        # The categories block must gain forklift or every new annotation
        # references a category id that does not exist.
        names = {c["name"] for c in coco["categories"]}
        if "forklift" not in names:
            coco["categories"].append({"id": CAT_ID["forklift"], "name": "forklift",
                                       "supercategory": "vehicle"})
        with open(ann_path, "w") as f:
            json.dump(coco, f)

    print(f"[forklift] added {added} forklift annotations across train+valid")


def main():
    ensure_deps()
    os.makedirs(WORK, exist_ok=True)
    build_dataset()
    append_roboflow_forklift()   # adds the 9th class on top of BMD-45
    verify_dataset()
    train()


if __name__ == "__main__":
    main()
