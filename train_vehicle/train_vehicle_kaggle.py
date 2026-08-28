#!/usr/bin/env python3
# =============================================================================
#  VEHICLE TYPE detector — SINGLE-FILE training pipeline (Kaggle / Colab GPU)
# =============================================================================
#  Trains ONE YOLO11 detection model over 8 vehicle classes:
#     0 two_wheeler  1 three_wheeler  2 car  3 van
#     4 lcv          5 truck          6 bus  7 bicycle
#
#  DATA SOURCE: BMD-45   https://huggingface.co/datasets/iisc-aim/BMD-45
#    45,986 images / 480K boxes from 3,679 Bengaluru Traffic Police Safe City
#    CCTV cameras. Pole-mounted 4-8 m, OBLIQUE viewing angles, 1920x1080.
#    This is REAL Indian CCTV from the exact camera geometry you deploy on —
#    that is why it transfers, where COCO/UA-DETRAC do not (the BMD-45 paper
#    reports 83.8% mAP training on it vs 33.6% training on other benchmarks).
#
#    Public, ungated, no login needed. Verified 13 annotated categories:
#      Hatchback Sedan SUV MUV Bus Truck Three-wheeler Two-wheeler
#      LCV Mini-bus Tempo-traveller Bicycle Van
#    (The paper mentions a 14th "Other" class; it is NOT in the released
#     annotations. We train the 13 that actually exist, merged into 8.)
#
#  KNOWN LIMITS of BMD-45 — plan for these:
#    * DAYTIME ONLY (06:00-18:00). Night / IR is your gap -> add site frames.
#    * License plates and faces are BLURRED (privacy). Fine for vehicle
#      detection; it is why ANPR must be a separate model on your own data.
#    * Bengaluru only.
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN ON KAGGLE
#  ---------------------------------------------------------------------------
#  1. New Kaggle Notebook.
#  2. Settings > Accelerator = GPU (T4 x2 or P100).  Settings > Internet = ON.
#  3. (Optional) your own CCTV frames — upload as a Kaggle Dataset containing
#     a folder named:
#         frames_labeled/   images + YOLO .txt labels     <- preferred
#       or
#         frames/           images only -> auto-prelabeled by COCO YOLO11
#  4. Upload this file and run:
#         !python train_vehicle_kaggle.py
#  5. Model lands at:
#         /kaggle/working/vehicle_best.pt
#
#  DISK / BANDWIDTH NOTE
#    BMD-45 images are 2.16 MB PNGs (~100 GB for the whole set) — far too big
#    for Kaggle. This script downloads each PNG, immediately re-encodes it to
#    JPEG q88 at 1280 px (~0.12 MB) and DELETES the PNG. Peak disk stays ~3 GB
#    for 20K images. Downloading 20K images pulls ~43 GB over the network,
#    which takes roughly 20-40 min on Kaggle. Lower CAP_BMD_TRAIN for a faster
#    first run (5000 is a good smoke test).
# =============================================================================

import os, sys, glob, json, random, shutil, subprocess, tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
random.seed(42)

# ------------------------------- CONFIG --------------------------------------
MODEL       = "yolo11s.pt"     # yolo11n(fastest) < yolo11s < yolo11m(most accurate)
IMGSZ       = 960              # CCTV vehicles are small/far -> bigger helps a lot
EPOCHS      = 100
PATIENCE    = 20               # early stop if val mAP stalls
BATCH       = 16               # GPU: 8-32 depending on VRAM. -1 = auto.

CAP_BMD_TRAIN = 20000          # of 35,792 available. 5000 = quick smoke test.
CAP_BMD_VAL   = 2500           # of 10,194 available.
CAP_SITE      = 4000           # your own CCTV frames

MAX_SIDE    = 1280             # re-encode longest side to this
JPEG_Q      = 88
DL_WORKERS  = 16               # parallel HF downloads

VAL_RATIO   = 0.12             # split ratio for the SITE pool only
                               # (BMD-45 ships its own train/val split)

# Keep all 13 BMD-45 classes instead of the merged 8? Merged 8 is what the VMS
# runtime needs; fine-grained is useful later for analytics / make+model.
FINE_GRAINED = False

SITE_DATA_DIR = ""             # "" = auto-locate frames_labeled/ or frames/

WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./vehicle_build")
DATA = os.path.join(WORK, "dataset")
POOL = os.path.join(WORK, "pool")
RUNS = os.path.join(WORK, "vehicle_runs")
REPO = "iisc-aim/BMD-45"

# ---------------------------- CLASS SCHEMA -----------------------------------
CLASSES = ["two_wheeler", "three_wheeler", "car", "van", "lcv",
           "truck", "bus", "bicycle"]

# BMD-45 category NAME -> our merged class id. Matched by NAME (normalised),
# never by index, so a re-export that renumbers ids cannot silently corrupt
# the labels.
BMD_TO_OURS = {
    "twowheeler":      0,
    "threewheeler":    1,
    "hatchback":       2, "sedan": 2, "suv": 2, "muv": 2,
    "van":             3,
    "lcv":             4, "tempotraveller": 4,
    "truck":           5,
    "bus":             6, "minibus": 6,
    "bicycle":         7,
}

# COCO-pretrained YOLO11 name -> our id, for auto-prelabeling YOUR frames.
# COCO has NO auto-rickshaw / LCV / tempo-traveller — those need a human pass
# in CVAT. Everything else comes free.
COCO_TO_OURS = {"motorcycle": 0, "car": 2, "truck": 5, "bus": 6, "bicycle": 7}

FINE_CLASSES = ["hatchback", "sedan", "suv", "muv", "bus", "truck",
                "three_wheeler", "two_wheeler", "lcv", "mini_bus",
                "tempo_traveller", "bicycle", "van"]

def active_classes():
    return FINE_CLASSES if FINE_GRAINED else CLASSES


# =============================================================================
def sh(*args):
    print("+", " ".join(args)); subprocess.check_call(args)

def ensure_deps():
    try:
        import ultralytics, huggingface_hub, PIL  # noqa
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q",
           "ultralytics", "huggingface_hub", "pillow")
    # much faster HF downloads when available
    try:
        import hf_transfer  # noqa
        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    except Exception:
        pass

def norm_key(s):
    """'Tempo-Traveller' / 'tempo traveller' -> 'tempotraveller'"""
    return "".join(ch for ch in str(s).lower() if ch.isalnum())

def map_name(name):
    """BMD-45 category name -> our class id (None = drop)."""
    k = norm_key(name)
    if FINE_GRAINED:
        for i, c in enumerate(FINE_CLASSES):
            if norm_key(c) == k:
                return i
        return None
    return BMD_TO_OURS.get(k)

def norm_box(x, y, w, h, W, H):
    """COCO [x,y,w,h] px -> YOLO cx,cy,nw,nh normalised. None if degenerate."""
    if w <= 0 or h <= 0:
        return None
    # clip the box to the frame before normalising
    x1, y1 = max(0.0, x), max(0.0, y)
    x2, y2 = min(float(W), x + w), min(float(H), y + h)
    if x2 <= x1 or y2 <= y1:
        return None
    cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
    nw, nh = (x2 - x1) / W, (y2 - y1) / H
    if nw <= 0 or nh <= 0:
        return None
    return cx, cy, nw, nh


# --------------------- 1) BMD-45 -> YOLO, streamed to disk --------------------
def select_images(coco, cap):
    """Choose which images to download.

    Naive head-of-list truncation starves the rare classes (bicycle,
    tempo-traveller, mini-bus are a tiny fraction of boxes). Instead score each
    image by the inverse frequency of the classes it contains and take the
    richest ones first, so a small cap still sees every class.
    """
    id2name = {c["id"]: c["name"] for c in coco["categories"]}
    per_img = defaultdict(list)
    freq = Counter()
    for a in coco["annotations"]:
        tgt = map_name(id2name.get(a["category_id"], ""))
        if tgt is None:
            continue
        per_img[a["image_id"]].append((tgt, a["bbox"]))
        freq[tgt] += 1

    imgs = [im for im in coco["images"] if per_img.get(im["id"])]
    if cap >= len(imgs):
        random.shuffle(imgs)
        return imgs, per_img, freq

    total = sum(freq.values()) or 1
    w = {c: total / (n + 1.0) for c, n in freq.items()}   # inverse frequency
    def score(im):
        cs = {t for t, _ in per_img[im["id"]]}
        return sum(w.get(c, 0.0) for c in cs) * random.uniform(0.85, 1.15)
    imgs.sort(key=score, reverse=True)
    return imgs[:cap], per_img, freq


def fetch_bmd45():
    from huggingface_hub import hf_hub_download
    from PIL import Image

    for folder, split, cap in (("BMD-45-Train", "train", CAP_BMD_TRAIN),
                               ("BMD-45-Val",   "val",   CAP_BMD_VAL)):
        print(f"\n[bmd45] === {folder} -> {split} (cap {cap}) ===")
        ann = hf_hub_download(REPO, f"{folder}/_annotations.coco.json",
                              repo_type="dataset")
        coco = json.load(open(ann))
        id2name = {c["id"]: c["name"] for c in coco["categories"]}

        unmapped = {n for n in id2name.values() if map_name(n) is None}
        if unmapped:
            print(f"[bmd45] categories with no mapping (dropped): {sorted(unmapped)}")

        chosen, per_img, freq = select_images(coco, cap)
        cls = active_classes()
        print(f"[bmd45] {len(coco['images'])} images available, taking {len(chosen)}")
        print(f"[bmd45] full-split box counts: "
              f"{ {cls[k]: v for k, v in sorted(freq.items())} }")

        img_dir = f"{DATA}/images/{split}"
        lbl_dir = f"{DATA}/labels/{split}"
        done = [0]
        failed = [0]

        def grab(im):
            """Download one PNG, re-encode to JPEG, delete the PNG."""
            rel = im["file_name"]                     # e.g. 'images_000/57.png'
            W, H = im["width"], im["height"]
            lines = []
            for tgt, bb in per_img[im["id"]]:
                nb = norm_box(bb[0], bb[1], bb[2], bb[3], W, H)
                if nb:
                    lines.append(f"{tgt} {nb[0]:.6f} {nb[1]:.6f} {nb[2]:.6f} {nb[3]:.6f}")
            if not lines:
                return
            base = f"bmd_{split}_{im['id']}"
            out_img = f"{img_dir}/{base}.jpg"
            if os.path.exists(out_img):
                return
            png = None
            try:
                png = hf_hub_download(REPO, f"{folder}/{rel}", repo_type="dataset")
                with Image.open(png) as pim:
                    pim = pim.convert("RGB")
                    if max(pim.size) > MAX_SIDE:
                        s = MAX_SIDE / float(max(pim.size))
                        pim = pim.resize((int(pim.size[0] * s), int(pim.size[1] * s)),
                                         Image.BILINEAR)
                    pim.save(out_img, quality=JPEG_Q)
                open(f"{lbl_dir}/{base}.txt", "w").write("\n".join(lines))
                done[0] += 1
                if done[0] % 1000 == 0:
                    print(f"   [bmd45/{split}] {done[0]}/{len(chosen)}")
            except Exception as e:
                failed[0] += 1
                if failed[0] <= 5:
                    print(f"   [bmd45] fail {rel}: {type(e).__name__} {str(e)[:120]}")
            finally:
                # critical: never let 2 MB PNGs accumulate — the full set is ~100 GB
                if png and os.path.exists(png):
                    try:
                        os.remove(png)
                    except Exception:
                        pass

        with ThreadPoolExecutor(max_workers=DL_WORKERS) as ex:
            list(ex.map(grab, chosen))
        print(f"[bmd45] {split}: wrote {done[0]} images ({failed[0]} failed)")


# --------------------- 2) optional: YOUR site CCTV frames ---------------------
def locate_site_dir():
    if SITE_DATA_DIR and os.path.isdir(SITE_DATA_DIR):
        return SITE_DATA_DIR
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.path.join(here, "frames_labeled"), os.path.join(here, "frames")]
    for root in ("/kaggle/input", "/content", here):
        if os.path.isdir(root):
            cands += glob.glob(f"{root}/**/frames_labeled", recursive=True)
            cands += glob.glob(f"{root}/**/frames", recursive=True)
    for c in cands:
        if os.path.isdir(c) and (glob.glob(f"{c}/*.jpg") or glob.glob(f"{c}/*.png")):
            return c
    return ""

def add_site():
    site_dir = locate_site_dir()
    if not site_dir:
        print("\n[site] no site frames found — training on PUBLIC (BMD-45) ONLY.")
        print("[site] Fine to start. Your gap vs BMD-45: NIGHT/IR (it is daytime")
        print("[site] only) and your specific mounting angles. Add frames later.")
        return
    print(f"\n[site] found site frames at: {site_dir}")
    imgs = sorted(glob.glob(f"{site_dir}/*.jpg") + glob.glob(f"{site_dir}/*.png"))[:CAP_SITE]
    has_labels = any(os.path.exists(os.path.splitext(i)[0] + ".txt") for i in imgs)

    if has_labels:
        print(f"[site] using {len(imgs)} pre-labeled site frames")
        for ip in imgs:
            tp = os.path.splitext(ip)[0] + ".txt"
            if not os.path.exists(tp):
                continue
            base = "site_" + os.path.basename(os.path.splitext(ip)[0])[:38]
            shutil.copy(ip, f"{POOL}/{base}.jpg")
            shutil.copy(tp, f"{POOL}/{base}.txt")
        return

    print(f"[site] auto-prelabeling {len(imgs)} raw frames with COCO YOLO11 ...")
    print("[site] NOTE: COCO cannot label auto-rickshaw / LCV / tempo-traveller.")
    print("[site] Those come out as 'car'/'truck' or get missed — fix in CVAT.")
    from ultralytics import YOLO
    import cv2
    det = YOLO("yolo11m.pt")
    kept = 0
    for ip in imgs:
        frame = cv2.imread(ip)
        if frame is None:
            continue
        H, W = frame.shape[:2]
        r = det.predict(frame, imgsz=IMGSZ, conf=0.35, verbose=False)[0]
        lines = []
        for b in r.boxes:
            tgt = COCO_TO_OURS.get(det.names[int(b.cls[0])])
            if tgt is None:
                continue
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            lines.append(f"{tgt} {(x1+x2)/2/W:.6f} {(y1+y2)/2/H:.6f} "
                         f"{(x2-x1)/W:.6f} {(y2-y1)/H:.6f}")
        if not lines:
            continue
        base = "site_" + os.path.basename(os.path.splitext(ip)[0])[:38]
        cv2.imwrite(f"{POOL}/{base}.jpg", frame)
        open(f"{POOL}/{base}.txt", "w").write("\n".join(lines))
        kept += 1
    print(f"[site] auto-prelabeled {kept}")


# --------------------- 3) merge site pool + write data.yaml -------------------
def merge_and_yaml():
    pairs = [(i, os.path.splitext(i)[0] + ".txt") for i in glob.glob(f"{POOL}/*.jpg")
             if os.path.exists(os.path.splitext(i)[0] + ".txt")]
    random.shuffle(pairs)
    n_val = int(len(pairs) * VAL_RATIO)
    for idx, (img, txt) in enumerate(pairs):
        sp = "val" if idx < n_val else "train"
        b = os.path.basename(img)
        shutil.copy(img, f"{DATA}/images/{sp}/{b}")
        shutil.copy(txt, f"{DATA}/labels/{sp}/{b[:-4]}.txt")
    if pairs:
        print(f"\n[merge] site pool: {len(pairs)} (train={len(pairs)-n_val} val={n_val})")

    cls = active_classes()
    yaml = f"{DATA}/data.yaml"
    with open(yaml, "w") as f:
        f.write(f"path: {DATA}\ntrain: images/train\nval: images/val\nnames:\n")
        for i, c in enumerate(cls):
            f.write(f"  {i}: {c}\n")

    tot, cnt = {}, Counter()
    for sp in ("train", "val"):
        tot[sp] = len(glob.glob(f"{DATA}/images/{sp}/*.jpg"))
        for t in glob.glob(f"{DATA}/labels/{sp}/*.txt"):
            for l in open(t):
                p = l.split()
                if p:
                    cnt[int(p[0])] += 1
    print(f"\n[dataset] images: train={tot['train']} val={tot['val']}")
    print("[dataset] box counts:", {cls[k]: v for k, v in sorted(cnt.items())})
    missing = [cls[i] for i in range(len(cls)) if cnt[i] == 0]
    if missing:
        print(f"[dataset] WARNING: zero boxes for {missing} — raise CAP_BMD_TRAIN")
    if tot["train"] == 0:
        sys.exit("[dataset] FATAL: no training images. Check Internet setting / HF access.")
    return yaml


# --------------------------------- 4) train ----------------------------------
def train(yaml):
    from ultralytics import YOLO
    import torch
    device = 0 if torch.cuda.is_available() else "cpu"
    print(f"\n[train] device={device}  model={MODEL}  imgsz={IMGSZ}  epochs={EPOCHS}")
    if device == "cpu":
        print("[train] WARNING: no GPU — this will be very slow. "
              "Kaggle: Settings > Accelerator > GPU.")
    m = YOLO(MODEL)
    m.train(data=yaml, epochs=EPOCHS, imgsz=IMGSZ, batch=BATCH, device=device,
            patience=PATIENCE, optimizer="auto", seed=42, save_period=10,
            project=RUNS, name="vehicle", exist_ok=True, plots=True,
            # Fixed CCTV geometry: vehicles are never upside-down and the camera
            # does not roll, so no vertical flip and only slight rotation. Scale
            # jitter is what buys robustness to near/far and mounting height.
            fliplr=0.5, flipud=0.0, degrees=5.0, scale=0.5, mosaic=1.0,
            hsv_h=0.015, hsv_s=0.7, hsv_v=0.4)

    best = f"{RUNS}/vehicle/weights/best.pt"
    if os.path.exists(best):
        shutil.copy(best, f"{WORK}/vehicle_best.pt")
        print(f"\n[done] BEST MODEL -> {WORK}/vehicle_best.pt")
        mm = YOLO(best)
        met = mm.val(data=yaml, imgsz=IMGSZ, device=device, verbose=False,
                     project=RUNS, name="vehicle_val", exist_ok=True)
        print(f"[done] val mAP50={met.box.map50:.3f}  mAP50-95={met.box.map:.3f}")
        cls = active_classes()
        try:
            for i, ap in enumerate(met.box.maps):
                print(f"        {cls[i]:<16} mAP50-95={ap:.3f}")
        except Exception:
            pass
        calibrate(yaml, met, best)
    else:
        print("[done] WARNING: best.pt not found — check logs")


# ------------------------- 5) production calibration -------------------------
#  Everything below turns the trained weights into runtime settings. None of
#  these numbers can be guessed before training — they are properties of the
#  weights + your data, so they are derived here and written to a JSON the VMS
#  runtime loads at startup.
# -----------------------------------------------------------------------------
def _pct(vals, q):
    if not vals:
        return None
    v = sorted(vals)
    return v[max(0, min(len(v) - 1, int(q * len(v))))]


def best_conf_per_class(metrics, cls):
    """Per-class confidence threshold at the peak of the F1-vs-confidence curve.

    Located by axis LABEL, not by index, so an ultralytics version bump that
    reorders curves_results cannot silently return the wrong curve.
    """
    out = {}
    try:
        curve = None
        for c in metrics.box.curves_results:
            # entry = (x, y, xlabel, ylabel)
            if len(c) >= 4 and str(c[2]).lower().startswith("conf") \
               and str(c[3]).upper() == "F1":
                curve = c
                break
        if curve is None:
            print("[calib] !! no Confidence/F1 curve found — falling back to 0.35")
            return {c: 0.35 for c in cls}, {}

        x, y = curve[0], curve[1]          # x:(1000,)  y:(nc,1000)
        raw = {}
        for i in range(min(len(y), len(cls))):
            f1 = y[i]
            j = int(max(range(len(f1)), key=lambda k: f1[k]))
            raw[cls[i]] = (float(x[j]), float(f1[j]))
        for name, (conf, f1) in raw.items():
            # Clamp: an F1 peak below ~0.15 is an artefact of a class the model
            # barely learned. Shipping it would flood the runtime with false
            # positives on cameras the model has never seen.
            out[name] = round(min(max(conf, 0.15), 0.75), 3)
        return out, raw
    except Exception as e:
        print(f"[calib] !! conf sweep failed ({type(e).__name__}: {e}) — using 0.35")
        return {c: 0.35 for c in cls}, {}


def geometry_priors(cls):
    """Per-class bbox aspect-ratio and pixel-size distribution, measured from
    the label files actually on disk.

    Used as an outlier REJECT gate, not a classifier: across 3,679 BMD-45
    cameras the per-class AR spread is 3-4x (camera angle), and classes overlap
    heavily, so tight AR gates would reject valid detections. p1/p99 is
    deliberately loose — it kills fused/degenerate boxes and nothing else.
    """
    from PIL import Image
    ar = defaultdict(list)
    size = defaultdict(list)
    dims = {}
    for sp in ("train", "val"):
        for tp in glob.glob(f"{DATA}/labels/{sp}/*.txt"):
            ip = f"{DATA}/images/{sp}/" + os.path.basename(tp)[:-4] + ".jpg"
            wh = dims.get(ip)
            if wh is None:
                try:
                    with Image.open(ip) as im:      # header only, no decode
                        wh = im.size
                except Exception:
                    continue
                dims[ip] = wh
            W, H = wh
            for l in open(tp):
                p = l.split()
                if len(p) != 5:
                    continue
                c = int(p[0])
                if c >= len(cls):
                    continue
                wpx, hpx = float(p[3]) * W, float(p[4]) * H
                if wpx <= 0 or hpx <= 0:
                    continue
                ar[cls[c]].append(wpx / hpx)
                size[cls[c]].append((wpx * hpx) ** 0.5)

    prof = {}
    for c in cls:
        v, s = ar[c], size[c]
        if not v:
            continue
        prof[c] = {
            "n": len(v),
            "ar_median":  round(_pct(v, .50), 3),
            "ar_p5":      round(_pct(v, .05), 3),
            "ar_p95":     round(_pct(v, .95), 3),
            "ar_reject_below": round(_pct(v, .01), 3),
            "ar_reject_above": round(_pct(v, .99), 3),
            "size_median":     round(_pct(s, .50), 1),
            "min_size_px":     round(_pct(s, .05), 1),
        }
    return prof


def calibrate(yaml, metrics, weights):
    cls = active_classes()
    print("\n" + "=" * 74)
    print(" PRODUCTION CALIBRATION")
    print("=" * 74)

    conf, raw = best_conf_per_class(metrics, cls)
    geo = geometry_priors(cls)

    print(f"\n{'class':<15}{'conf':>7}{'F1@conf':>9}{'AR med':>8}"
          f"{'AR rej<':>9}{'AR rej>':>9}{'min px':>8}{'boxes':>9}")
    for c in cls:
        g = geo.get(c, {})
        f1 = raw.get(c, (None, None))[1]
        print(f"{c:<15}{conf.get(c, 0.35):>7.3f}"
              f"{(f'{f1:.3f}' if f1 is not None else '-'):>9}"
              f"{g.get('ar_median', '-'):>8}{g.get('ar_reject_below', '-'):>9}"
              f"{g.get('ar_reject_above', '-'):>9}{g.get('min_size_px', '-'):>8}"
              f"{g.get('n', 0):>9}")

    profile = {
        "model": os.path.basename(weights),
        "imgsz": IMGSZ,
        "classes": cls,
        "conf_threshold": conf,
        "global_conf_floor": round(min(conf.values()), 3) if conf else 0.25,
        "iou_nms": 0.6,
        "geometry": geo,
        "notes": {
            "conf_threshold": "Per-class F1-optimal on the val set, clamped to "
                              "[0.15, 0.75]. Set the detector to run at "
                              "global_conf_floor, then apply the per-class "
                              "threshold when filtering results.",
            "geometry": "AR reject bounds are p1/p99 — an outlier gate only. "
                        "Do NOT use aspect ratio to decide class: across "
                        "camera angles the per-class AR ranges overlap almost "
                        "completely (e.g. car vs bus).",
            "min_size_px": "sqrt(w*h) below this is smaller than the training "
                           "data annotates — treat as unreliable.",
            "per_camera": "These are global values. For tight gates, re-run "
                          "geometry_priors() per camera: one fixed camera has "
                          "one angle, so its per-class AR spread is narrow and "
                          "genuinely discriminative.",
            "daylight_only": "Training data (BMD-45) is 06:00-18:00. Expect "
                             "these thresholds to be optimistic at night until "
                             "site night frames are added.",
        },
    }
    out = f"{WORK}/vehicle_profile.json"
    with open(out, "w") as f:
        json.dump(profile, f, indent=2)
    print(f"\n[calib] runtime profile -> {out}")
    print("[calib] ship this JSON next to vehicle_best.pt")
    return profile


def main():
    ensure_deps()
    for s in ("images/train", "images/val", "labels/train", "labels/val"):
        os.makedirs(f"{DATA}/{s}", exist_ok=True)
    os.makedirs(POOL, exist_ok=True)
    fetch_bmd45()
    add_site()
    yaml = merge_and_yaml()
    train(yaml)


if __name__ == "__main__":
    main()
