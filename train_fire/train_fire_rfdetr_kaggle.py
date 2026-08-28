#!/usr/bin/env python3
# =============================================================================
#  FIRE + SMOKE detector — RF-DETR (Apache-2.0) — single-file Kaggle trainer
# =============================================================================
#  VERIFIED LICENCE CHAIN (all free for commercial use):
#    rfdetr code ................ Apache-2.0
#    RF-DETR N/S/M/L weights .... Apache-2.0
#    DINOv2 backbone ............ Apache-2.0 (Meta relicensed Aug 2023)
#    every dataset below ........ CC BY 4.0, read FIRST-HAND from the Roboflow
#                                 API (GET https://api.roboflow.com/<ws>/<proj>)
#  *** NEVER use RFDETRXLarge / RFDETR2XLarge — PML-1.0, needs a paid plan.
#
#  CC BY 4.0 permits commercial use. Its one obligation is ATTRIBUTION: every
#  source is listed in the repo's NOTICE file, which ships with the product.
#
#  2 classes: fire  smoke
#
#  ---------------------------------------------------------------------------
#  WHY FIRE AND SMOKE ARE SEPARATE CLASSES
#  ---------------------------------------------------------------------------
#  Smoke almost always precedes visible flame, so smoke is the EARLY warning and
#  fire is the confirmation. Collapsing them into one "fire" class throws away
#  the minutes that make the feature worth buying. They also look nothing alike:
#  flame is small, bright and high-contrast; smoke is large, low-contrast and
#  semi-transparent, which is why smoke scores lower and needs its own
#  confidence floor at runtime.
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN
#  ---------------------------------------------------------------------------
#  1. New Kaggle Notebook.
#  2. Settings -> Accelerator = "GPU T4 x2"   <-- REQUIRED.
#     DEVICES=2 does not request hardware; on one T4 this runs at half speed
#     and the epoch-budget estimate will be wrong.
#  3. Settings -> Internet = ON.
#  4. Upload this file, then run ONE cell:
#
#         !python train_fire_rfdetr_kaggle.py
#
#     RUN IT AS A SCRIPT, NOT BY PASTING INTO A CELL. Multi-GPU training uses
#     DDP, which spawns worker processes — that works from a subprocess but
#     hangs inside a notebook kernel.
#
#  5. WATCH THE [budget] BLOCK printed before training starts. If it warns the
#     epoch count is too low it prints the exact RESOLUTION to use instead.
#     Stop, change that one constant, re-run. One minute now beats hour eleven.
#
#  OUTPUT -> /kaggle/working/fire_rfdetr/
#     checkpoint_best_ema.pth   the trained weights
#     rfdetr-small.onnx         <-- DOWNLOAD THIS; the worker runs ONNX
# =============================================================================

import json
import os
import subprocess
import sys
from collections import Counter, defaultdict

# ###########################################################################
# ##  REMOVE THIS LINE BEFORE COMMITTING OR SHIPPING  ########################
# ##  Rotate at roboflow.com -> Settings -> API Keys -> Generate New Key    ##
# ###########################################################################
ROBOFLOW_API_KEY = "voHdj2XwXqhS3L5aNxXa"
# ###########################################################################

MODEL_SIZE = "small"      # nano | small | medium | large  (Apache-2.0 only)

# Must be divisible by 32 — verified empirically, not from the docs: the
# backbone asserts it at the FORWARD pass, so a bad value is accepted by the
# constructor and only explodes once training starts.
# Fire/smoke are LARGE regions, unlike a helmet on a distant worker, so this
# does not need the 768 the PPE model wanted.
RESOLUTION = 640

EPOCHS = 60               # upper bound; plan_budget() lowers it to what fits
TIME_BUDGET_HOURS = 10.5  # Kaggle kills at 12h — leave room for build + export

BATCH_SIZE = 4            # PER DEVICE under DDP
GRAD_ACCUM = 2            # 4 x 2 x 2 gpu = effective 16
LR = 1e-4
AMP_DTYPE = "fp16"        # T4 is Turing: no bf16 tensor cores
DEVICES = 2
EARLY_STOPPING = True
EARLY_STOPPING_PATIENCE = 12
VAL_RATIO = 0.12          # used only when a source has no valid/ split

WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./fire_build")
MERGED = os.path.join(WORK, "fire_dataset")
OUT = os.path.join(WORK, "fire_rfdetr")

CLASSES = ["fire", "smoke"]
CAT_ID = {n: i + 1 for i, n in enumerate(CLASSES)}   # COCO ids are 1-based

# Source class name -> ours. Keys are NORMALISED (lowercase, alphanumeric only)
# so "Fire", "FIRE" and "fire " all collapse to the same key.
NAME_MAP = {
    "fire": "fire", "flame": "fire", "flames": "fire", "wildfire": "fire",
    "smoke": "smoke", "smokedutofire": "smoke", "smokeduetofire": "smoke",
    # Explicitly dropped: these appear in mixed datasets and are not ours.
    "gun": None, "knife": None, "person": None, "default": None,
}

# Licence and counts read FIRST-HAND from the Roboflow API, not a search result.
# (workspace, project, version, licence)
#  VERSIONS WERE CHECKED AGAINST THE API, NOT ASSUMED. Two would have failed:
#    hiwia has ONLY v2 — a v1 request 404s, and that is the biggest source, so
#      the run would have quietly trained on a quarter of the data.
#    sdgt9's v1 is the AUGMENTED one (1,888) while v3 is raw (469) — the
#      opposite of the usual pattern, so "use the lowest version" is wrong too.
#  Prefer RAW over augmented: RF-DETR augments during training, and
#  pre-augmented copies mostly teach the model the augmentation.
ROBOFLOW_SOURCES = [
    # v2 = 15,345 imgs (augmented; it is the ONLY version, so no raw choice).
    # Project-level uniques: 6,391 | fire 10,559, smoke 9,096. The backbone.
    ("middle-east-tech-university", "fire-and-smoke-detection-hiwia", 2, "CC BY 4.0"),
    # 855 imgs | fire 639, smoke 622   (v1 == v2, both raw)
    ("data2", "fire-smoke-detection-ua3dm", 1, "CC BY 4.0"),
    # 482 imgs | fire 675  (fire only, no smoke)
    ("smoke-and-fire-detecttion", "fire-dataset-kdtib", 1, "CC BY 4.0"),
    # v3 = 469 RAW  (v1 = 1,888 is augmented — do not use it)
    ("mahmoud-9wyf6", "fire-and-smoke-detection-sdgt9", 3, "CC BY 4.0"),
]

DATASET_DIRS = []          # extra COCO dirs you attach yourself (Kaggle Input)


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


def norm(s):
    return "".join(c for c in str(s).lower() if c.isalnum())


def find_splits(root):
    """Return {split_name: dir} for any COCO splits present under `root`."""
    out = {}
    for cand in ("train", "valid", "val", "test"):
        d = os.path.join(root, cand)
        if os.path.exists(os.path.join(d, "_annotations.coco.json")):
            out["valid" if cand in ("valid", "val") else cand] = d
    if not out and os.path.exists(os.path.join(root, "_annotations.coco.json")):
        out["train"] = root
    return out


def fetch_roboflow(work_root: str) -> list:
    """Download the CC BY 4.0 sources in COCO format.

    NEVER raises: a missing key or a moved project must not destroy an
    otherwise valid run, so every failure is named and skipped.
    """
    key = (ROBOFLOW_API_KEY or "").strip() or os.environ.get("ROBOFLOW_API_KEY", "").strip()
    if not key:
        try:
            from kaggle_secrets import UserSecretsClient
            key = UserSecretsClient().get_secret("ROBOFLOW_API_KEY")
        except Exception:  # noqa: BLE001
            key = ""
    if not key:
        sys.exit(
            "\nNo ROBOFLOW_API_KEY. Every dataset for this model lives on Roboflow\n"
            "Universe, which does not serve anonymously, so there is nothing to\n"
            "train on. Get a free key at roboflow.com -> Settings -> API Keys and\n"
            "either set the constant at the top of this file or add a Kaggle Secret\n"
            "named ROBOFLOW_API_KEY.\n"
        )

    try:
        import roboflow  # noqa: F401
    except ImportError:
        sh(sys.executable, "-m", "pip", "install", "-q", "roboflow")

    from roboflow import Roboflow
    rf = Roboflow(api_key=key)

    dirs = []
    for ws, proj, ver, lic in ROBOFLOW_SOURCES:
        dest = os.path.join(work_root, f"rf_{proj[:30]}")
        if os.path.isdir(dest) and os.listdir(dest):
            print(f"[roboflow] {proj} already present — reusing")
            dirs.append(dest)
            continue
        try:
            print(f"[roboflow] fetching {ws}/{proj} v{ver}  ({lic})")
            ds = rf.workspace(ws).project(proj).version(ver).download(
                "coco", location=dest, overwrite=False)
            dirs.append(getattr(ds, "location", dest))
        except Exception as e:  # noqa: BLE001
            print(f"[roboflow] FAILED {ws}/{proj} v{ver}: {type(e).__name__}: {e}")
            print(f"[roboflow] skipping — check the project is still public and the")
            print(f"[roboflow] version number still exists on its Universe page")
    return dirs


def merge_datasets():
    """Merge every source COCO dataset into one, remapped to fire/smoke."""
    sources = fetch_roboflow(WORK) + list(DATASET_DIRS)
    if not sources:
        sys.exit("[merge] no dataset sources resolved — nothing to train on")

    unmapped = Counter()
    kept = Counter()

    for split in ("train", "valid"):
        os.makedirs(os.path.join(MERGED, split), exist_ok=True)

    acc = {s: {"images": [], "annotations": []} for s in ("train", "valid")}
    next_img = {"train": 1, "valid": 1}
    next_ann = {"train": 1, "valid": 1}

    for root in sources:
        if not os.path.isdir(root):
            print(f"[merge] !! missing dir: {root}")
            continue
        splits = find_splits(root)
        if not splits:
            print(f"[merge] !! no COCO splits under {root}")
            continue
        print(f"\n[merge] {root}  splits={list(splits)}")

        for split, sdir in splits.items():
            if split == "test":
                continue
            coco = json.load(open(os.path.join(sdir, "_annotations.coco.json")))
            id2name = {c["id"]: c["name"] for c in coco["categories"]}

            # Report what this source calls things, so a silently-dropped class
            # is impossible to miss.
            mapped = {n: NAME_MAP.get(norm(n)) for n in id2name.values()}
            print(f"   {split}: {({k: (v or 'DROPPED') for k, v in mapped.items()})}")
            for n, v in mapped.items():
                if v is None:
                    unmapped[n] += 1

            by_img = defaultdict(list)
            for a in coco["annotations"]:
                tgt = NAME_MAP.get(norm(id2name.get(a["category_id"], "")))
                if tgt:
                    by_img[a["image_id"]].append((tgt, a["bbox"]))

            tgt_split = split if split in acc else "train"
            for im in coco["images"]:
                anns = by_img.get(im["id"], [])
                if not anns:
                    continue  # no usable boxes -> the image teaches nothing here
                src = os.path.join(sdir, im["file_name"])
                if not os.path.exists(src):
                    continue

                # Prefix the filename with the source dir so two datasets that
                # both contain "IMG_0001.jpg" cannot overwrite each other.
                tag = os.path.basename(root.rstrip("/"))[:18]
                fname = f"{tag}_{im['id']}_{os.path.basename(im['file_name'])}"
                dst = os.path.join(MERGED, tgt_split, fname)
                if not os.path.exists(dst):
                    try:
                        os.link(src, dst)      # hardlink: no copy, no extra disk
                    except OSError:
                        import shutil
                        shutil.copy2(src, dst)

                iid = next_img[tgt_split]
                next_img[tgt_split] += 1
                acc[tgt_split]["images"].append({
                    "id": iid, "file_name": fname,
                    "width": im.get("width", 0), "height": im.get("height", 0),
                })
                for cls, bbox in anns:
                    acc[tgt_split]["annotations"].append({
                        "id": next_ann[tgt_split], "image_id": iid,
                        "category_id": CAT_ID[cls], "bbox": bbox,
                        "area": float(bbox[2]) * float(bbox[3]), "iscrowd": 0,
                    })
                    next_ann[tgt_split] += 1
                    kept[cls] += 1

    # If no source provided a valid split, carve one out of train.
    if not acc["valid"]["images"] and acc["train"]["images"]:
        n_val = max(1, int(len(acc["train"]["images"]) * VAL_RATIO))
        print(f"\n[merge] no valid split in any source — moving {n_val} images from train")
        move = {im["id"] for im in acc["train"]["images"][:n_val]}
        acc["valid"]["images"] = [im for im in acc["train"]["images"] if im["id"] in move]
        acc["valid"]["annotations"] = [a for a in acc["train"]["annotations"] if a["image_id"] in move]
        acc["train"]["images"] = [im for im in acc["train"]["images"] if im["id"] not in move]
        acc["train"]["annotations"] = [a for a in acc["train"]["annotations"] if a["image_id"] not in move]
        for im in acc["valid"]["images"]:
            src = os.path.join(MERGED, "train", im["file_name"])
            dst = os.path.join(MERGED, "valid", im["file_name"])
            if os.path.exists(src) and not os.path.exists(dst):
                os.replace(src, dst)

    for split in ("train", "valid"):
        with open(os.path.join(MERGED, split, "_annotations.coco.json"), "w") as f:
            json.dump({
                "info": {"description": "fire/smoke merged", "version": "1.0"},
                "licenses": [],
                "images": acc[split]["images"],
                "categories": [{"id": CAT_ID[n], "name": n, "supercategory": "hazard"}
                               for n in CLASSES],
                "annotations": acc[split]["annotations"],
            }, f)

    print(f"\n[merge] kept per class: {dict(kept)}")
    if unmapped:
        print(f"[merge] source classes DROPPED (not ours): {dict(unmapped)}")


def verify():
    ok = True
    for split in ("train", "valid"):
        p = os.path.join(MERGED, split, "_annotations.coco.json")
        if not os.path.exists(p):
            print(f"[check] MISSING {p}")
            ok = False
            continue
        j = json.load(open(p))
        d = os.path.dirname(p)
        miss = sum(1 for im in j["images"][:50]
                   if not os.path.exists(os.path.join(d, im["file_name"])))
        print(f"[check] {split}: {len(j['images'])} images, {len(j['annotations'])} boxes, "
              f"{miss}/50 sampled files missing")
        if not j["images"] or not j["annotations"] or miss:
            ok = False
    if not ok:
        sys.exit("[check] dataset invalid — aborting before training")


# Measured on the vehicle run with this exact stack (RF-DETR Small, fp16, T4,
# batch 4/GPU): 20,000 images at 512px on ONE T4 = 31.7 min/epoch.
SEC_PER_IMAGE_AT_512_PER_GPU = 0.095
DDP_EFFICIENCY = 0.95
MIN_USEFUL_EPOCHS = 25


def count_train_images() -> int:
    with open(os.path.join(MERGED, "train", "_annotations.coco.json")) as f:
        return len(json.load(f)["images"])


def plan_budget(n: int) -> int:
    """Estimate epoch time and return the epochs that actually fit."""
    pixel_factor = (RESOLUTION / 512.0) ** 2
    per_epoch = SEC_PER_IMAGE_AT_512_PER_GPU * n * pixel_factor / max(1, DEVICES) / DDP_EFFICIENCY
    budget_s = TIME_BUDGET_HOURS * 3600.0
    fits = max(1, int(budget_s // per_epoch))
    planned = min(EPOCHS, fits)

    print("\n" + "=" * 68)
    print(f"[budget] train images        : {n:,}")
    print(f"[budget] resolution          : {RESOLUTION}px  ({pixel_factor:.2f}x the pixels of 512)")
    print(f"[budget] devices             : {DEVICES}")
    print(f"[budget] estimated per epoch : {per_epoch/60:.1f} min")
    print(f"[budget] time budget         : {TIME_BUDGET_HOURS} h -> {fits} epochs fit")
    print(f"[budget] TRAINING            : {planned} epochs (~{planned*per_epoch/3600:.1f} h)")
    if planned < EPOCHS:
        print(f"[budget] NOTE: capped from {EPOCHS} so the run ENDS on its own rather")
        print(f"[budget]       than being killed at the 12h wall mid-epoch.")
    if planned < MIN_USEFUL_EPOCHS:
        target = budget_s / MIN_USEFUL_EPOCHS
        ratio = target * DEVICES * DDP_EFFICIENCY / (SEC_PER_IMAGE_AT_512_PER_GPU * n)
        suggested = int((512 * (ratio ** 0.5)) // 32 * 32)
        print(f"[budget]")
        print(f"[budget] *** WARNING: {planned} epochs is NOT ENOUGH. ***")
        if suggested >= 512:
            print(f"[budget] FIX: set RESOLUTION = {suggested} -> about {MIN_USEFUL_EPOCHS} epochs")
        else:
            print(f"[budget] FIX: cap the dataset; it is too large for {TIME_BUDGET_HOURS}h")
        print(f"[budget] Edit the constant and re-run — do not train as-is.")
    print("=" * 68 + "\n")
    return planned


def train():
    import rfdetr
    cls = {"nano": "RFDETRNano", "small": "RFDETRSmall",
           "medium": "RFDETRMedium", "large": "RFDETRLarge"}[MODEL_SIZE]

    planned = plan_budget(count_train_images())
    eff = BATCH_SIZE * GRAD_ACCUM * DEVICES
    print(f"[train] {cls} @ {RESOLUTION}px  epochs={planned}  "
          f"batch {BATCH_SIZE}/gpu x accum {GRAD_ACCUM} x {DEVICES} gpu = effective {eff}  lr={LR}")

    # resolution goes to the CONSTRUCTOR, not train(): it changes the positional
    # encoding size, which is baked in at build time.
    model = getattr(rfdetr, cls)(resolution=RESOLUTION)
    model.train(dataset_dir=MERGED, epochs=planned, batch_size=BATCH_SIZE,
                grad_accum_steps=GRAD_ACCUM, lr=LR, output_dir=OUT,
                amp_dtype=AMP_DTYPE, devices=DEVICES,
                early_stopping=EARLY_STOPPING,
                early_stopping_patience=EARLY_STOPPING_PATIENCE)

    print(f"\n[done] checkpoints in {OUT}")
    for f in ("checkpoint_best_ema.pth", "checkpoint_best_regular.pth"):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            print(f"   {f}  {os.path.getsize(p)/1e6:.1f} MB")
    export_onnx()


def export_onnx():
    """Export the best EMA checkpoint to ONNX in the SAME session.

    The runtime is onnxruntime, not PyTorch. Exporting here matters because the
    rfdetr + torch stack is already installed and correct; reproducing it
    locally means a multi-GB torch install to run a converter once.

    Non-fatal: the .pth is saved either way.
    """
    import rfdetr
    ck = os.path.join(OUT, "checkpoint_best_ema.pth")
    if not os.path.exists(ck):
        print("[export] no checkpoint_best_ema.pth — skipping")
        return
    cls = {"nano": "RFDETRNano", "small": "RFDETRSmall",
           "medium": "RFDETRMedium", "large": "RFDETRLarge"}[MODEL_SIZE]
    try:
        m = getattr(rfdetr, cls)(pretrain_weights=ck, num_classes=len(CLASSES),
                                 resolution=RESOLUTION)
        out = m.export(output_dir=OUT, opset_version=17, verbose=False)
        print(f"[export] ONNX written: {out}")
        print(f"[export] input is {RESOLUTION}x{RESOLUTION}")
        print("[export] DOWNLOAD THIS .onnx — it is what the worker runs.")
    except Exception as e:  # noqa: BLE001
        print(f"[export] ONNX export FAILED: {type(e).__name__}: {e}")
        print(f"[export] Re-run later with rfdetr.{cls}(pretrain_weights=..., "
              f"num_classes={len(CLASSES)}, resolution={RESOLUTION}).export()")
    print("[export] CC BY 4.0 sources require attribution — keep the NOTICE file "
          "with the product.")


def main():
    ensure_deps()
    os.makedirs(WORK, exist_ok=True)
    merge_datasets()
    verify()
    train()


if __name__ == "__main__":
    main()
