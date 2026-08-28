#!/usr/bin/env python3
# =============================================================================
#  PPE + PERSON detector — SINGLE-FILE training pipeline (Kaggle / Colab GPU)
# =============================================================================
#  Trains ONE YOLO11 detection model over 9 classes:
#     0 person  1 helmet  2 no_helmet  3 vest  4 no_vest
#     5 gloves  6 no_gloves  7 boots  8 no_boots
#  (Pose/skeleton stays a separate yolo11-pose model in the runtime pipeline.)
#
#  It builds the dataset from public datasets automatically, optionally mixes in
#  YOUR site frames, then trains on GPU and saves best.pt.
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN ON KAGGLE
#  ---------------------------------------------------------------------------
#  1. Create a new Kaggle Notebook.
#  2. Settings ▸ Accelerator = GPU (T4 x2 or P100).  Settings ▸ Internet = ON.
#  3. (Optional) To include your own site frames, upload them as a Kaggle
#     Dataset and set SITE_DATA_DIR below to that input path, e.g.
#         /kaggle/input/my-ppe-site/frames_labeled     (images + .txt labels)
#       or
#         /kaggle/input/my-ppe-site/frames             (images only -> auto-labeled)
#     Leave it as "" to train on public data only.
#  4. Upload THIS file (or paste it into a cell) and run:
#         !python train_ppe_kaggle.py
#  5. When done, download the model from:
#         /kaggle/working/ppe_runs/ppe_person/weights/best.pt
#     (also copied to /kaggle/working/ppe_person_best.pt)
#
#  On Google Colab it works the same (set SITE_DATA_DIR to a Drive/uploaded path).
# =============================================================================

import os, sys, glob, zipfile, random, shutil, subprocess
random.seed(42)

# ------------------------------- CONFIG --------------------------------------
MODEL       = "yolo11s.pt"     # yolo11n(fastest) < yolo11s < yolo11m(most accurate). GPU can do s/m.
IMGSZ       = 800              # bigger helps small gloves/shoes; 640 is faster. GPU can do 800-960.
EPOCHS      = 100
PATIENCE    = 20               # early stop if val mAP stalls
BATCH       = 32               # GPU: 16-64 depending on VRAM. -1 = auto.
VAL_RATIO   = 0.12

# per-source image caps (raise/lower to trade dataset size vs time)
CAP_HIEN    = 8000             # hiennguyen: helmet/vest/glove/shoes  (positives)
CAP_HARDHAT = 5000             # hf-vision : helmet/head->no_helmet/person
CAP_FRAN    = 1300             # francesco : vest/no_vest/helmet/no_helmet/person
CAP_BIDJOE  = 6000             # BIDJOE    : glove + NO_GLOVE negatives (+ some others)
CAP_SITE    = 4000             # your frames

# Your REAL site frames ship inside the same Kaggle dataset as this script (folder
# "frames_labeled"). Leave "" to auto-locate it; the script searches next to itself
# and under /kaggle/input. Set an explicit path only to override.
SITE_DATA_DIR = ""

WORK   = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.path.abspath("./ppe_build")
DATA   = os.path.join(WORK, "dataset")
POOL   = os.path.join(WORK, "pool")           # all image+label pairs land here first
RUNS   = os.path.join(WORK, "ppe_runs")
CLASSES = ["person","helmet","no_helmet","vest","no_vest","gloves","no_gloves","boots","no_boots"]

# =============================================================================
def sh(*args):
    print("+", " ".join(args)); subprocess.check_call(args)

def ensure_deps():
    try:
        import ultralytics, datasets, imagehash, huggingface_hub  # noqa
    except Exception:
        sh(sys.executable, "-m", "pip", "install", "-q",
           "ultralytics", "datasets", "imagehash", "huggingface_hub", "pillow")

def norm_box(x, y, w, h, W, H):
    """COCO [x,y,w,h] px -> YOLO cx,cy,w,h normalized. Returns None if degenerate."""
    cx, cy, nw, nh = (x + w/2)/W, (y + h/2)/H, w/W, h/H
    if nw <= 0 or nh <= 0 or nw > 1.5 or nh > 1.5:
        return None
    return cx, cy, nw, nh

# --------------------------- 1) HF streaming sources -------------------------
def fetch_hf():
    from datasets import load_dataset
    from PIL import Image  # noqa
    sources = [
        ("hiennguyen9874/ppe-detection", "train", CAP_HIEN,
            {"helmet":1, "vest":3, "glove":5, "shoes":7}),
        ("hf-vision/hardhat", "train", CAP_HARDHAT,
            {"helmet":1, "head":2, "person":0}),
        ("Francesco/construction-safety-gsnvb", "train", CAP_FRAN,
            {"helmet":1, "no-helmet":2, "vest":3, "no-vest":4, "person":0}),
    ]
    for repo, split, cap, cmap in sources:
        print(f"\n[hf] {repo} (cap {cap}) ...")
        ds = load_dataset(repo, split=split, streaming=True)
        try:
            names = ds.features["objects"]["category"].feature.names
        except Exception:
            names = None
        tag = repo.split("/")[-1][:6]
        n = 0
        for i, ex in enumerate(ds):
            if n >= cap:
                break
            try:
                img = ex["image"].convert("RGB")
            except Exception:
                continue
            W, Hh = img.size
            o = ex["objects"]
            lines = []
            for bbox, cat in zip(o["bbox"], o["category"]):
                name = names[cat] if names is not None else cat
                tgt = cmap.get(str(name).lower())
                if tgt is None:
                    continue
                nb = norm_box(*bbox, W, Hh)
                if nb: lines.append(f"{tgt} {nb[0]:.6f} {nb[1]:.6f} {nb[2]:.6f} {nb[3]:.6f}")
            if not lines:
                continue
            base = f"hf_{tag}_{i:06d}"
            img.save(f"{POOL}/{base}.jpg", quality=90)
            open(f"{POOL}/{base}.txt", "w").write("\n".join(lines))
            n += 1
            if n % 1000 == 0: print(f"   {repo}: {n}/{cap}")
        print(f"[hf] {repo}: wrote {n}")

# --------------------------- 2) BIDJOE (the negatives) -----------------------
def fetch_bidjoe():
    from huggingface_hub import hf_hub_download
    print(f"\n[bidjoe] downloading ppe-14classes (~1.1GB) ...")
    zpath = hf_hub_download(repo_id="BIDJOE/ppe-14classes",
                            filename="dataset_bidjoe_14classes.zip", repo_type="dataset")
    ex = os.path.join(WORK, "bidjoe")
    if not os.path.isdir(ex):
        with zipfile.ZipFile(zpath) as z:
            z.extractall(ex)
    # BIDJOE id -> our schema:  glove,helmet,no_glove,no_helmet,no_shoes,shoes,no_safety_vest,safety_vest
    BID = {0:5, 2:1, 5:6, 7:2, 9:8, 10:7, 12:4, 13:3}
    NEG = {2,4,6,8}
    pairs = []
    for split in ("train","valid"):
        for txt in glob.glob(f"{ex}/**/{split}/labels/*.txt", recursive=True):
            for e in (".jpg",".jpeg",".png"):
                img = txt.replace("/labels/","/images/")
                img = os.path.splitext(img)[0] + e
                if os.path.exists(img):
                    pairs.append((img, txt)); break
    conv = []
    for img, txt in pairs:
        out, has_neg = [], False
        for line in open(txt):
            p = line.split()
            if len(p) != 5: continue
            tgt = BID.get(int(p[0]))
            if tgt is None: continue
            if tgt in NEG: has_neg = True
            out.append(f"{tgt} {p[1]} {p[2]} {p[3]} {p[4]}")
        if out: conv.append((img, out, has_neg))
    random.shuffle(conv)
    conv.sort(key=lambda x: not x[2])   # negatives first
    n = 0
    for img, lines, _ in conv[:CAP_BIDJOE]:
        base = "bid_" + os.path.splitext(os.path.basename(img))[0][:38]
        shutil.copy(img, f"{POOL}/{base}.jpg")
        open(f"{POOL}/{base}.txt","w").write("\n".join(lines))
        n += 1
    print(f"[bidjoe] wrote {n}")

# --------------------------- 3) optional site frames -------------------------
def locate_site_dir():
    """Find the bundled 'frames_labeled' folder (ships with this script)."""
    if SITE_DATA_DIR and os.path.isdir(SITE_DATA_DIR):
        return SITE_DATA_DIR
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, "frames_labeled"), os.path.join(here, "frames")]
    # search Kaggle/Colab input mounts
    for root in ("/kaggle/input", "/content", here):
        if os.path.isdir(root):
            candidates += glob.glob(f"{root}/**/frames_labeled", recursive=True)
            candidates += glob.glob(f"{root}/**/frames", recursive=True)
    for c in candidates:
        if os.path.isdir(c) and (glob.glob(f"{c}/*.jpg") or glob.glob(f"{c}/*.png")):
            return c
    return ""

def add_site():
    site_dir = locate_site_dir()
    if not site_dir:
        print("\n[site] *** WARNING: site frames not found — training on PUBLIC ONLY. ***")
        print("[site] Make sure 'frames_labeled/' is in the same Kaggle dataset as this script.")
        return
    print(f"\n[site] found real site frames at: {site_dir}")
    imgs = sorted(glob.glob(f"{site_dir}/*.jpg") + glob.glob(f"{site_dir}/*.png"))[:CAP_SITE]
    has_labels = any(os.path.exists(os.path.splitext(i)[0] + ".txt") for i in imgs)
    if has_labels:
        print(f"\n[site] using {len(imgs)} pre-labeled site frames")
        for ip in imgs:
            tp = os.path.splitext(ip)[0] + ".txt"
            if not os.path.exists(tp): continue
            base = "site_" + os.path.basename(os.path.splitext(ip)[0])[:38]
            shutil.copy(ip, f"{POOL}/{base}.jpg"); shutil.copy(tp, f"{POOL}/{base}.txt")
    else:
        print(f"\n[site] auto-labeling {len(imgs)} raw site frames (pose + YOLO11s PPE)...")
        from ultralytics import YOLO
        from huggingface_hub import hf_hub_download
        import cv2
        pose = YOLO("yolo11n-pose.pt")
        ppe_w = hf_hub_download("Sajjad-Ali-Shah/ppe-yolo11s", "best_ppe_model.pt")
        ppe = YOLO(ppe_w)
        PPE_MAP = {"Helmet":1,"no_helmet":2,"Vest":3,"Gloves":5,"no_gloves":6,"Boots":7,"no_boots":8}
        for k, ip in enumerate(imgs):
            frame = cv2.imread(ip)
            if frame is None: continue
            H, W = frame.shape[:2]; lines = []
            pr = pose.predict(frame, imgsz=640, conf=0.40, classes=[0], verbose=False)[0]
            persons = []
            for b in pr.boxes:
                x1,y1,x2,y2 = b.xyxy[0].tolist(); persons.append((x1,y1,x2,y2))
                lines.append(f"0 {(x1+x2)/2/W:.6f} {(y1+y2)/2/H:.6f} {(x2-x1)/W:.6f} {(y2-y1)/H:.6f}")
            for (x1,y1,x2,y2) in persons:
                pw,ph = x2-x1, y2-y1
                X1=max(0,int(x1-0.2*pw));Y1=max(0,int(y1-0.2*ph));X2=min(W,int(x2+0.2*pw));Y2=min(H,int(y2+0.2*ph))
                crop = frame[Y1:Y2, X1:X2]
                if crop.size == 0: continue
                up = cv2.resize(crop, (crop.shape[1]*2, crop.shape[0]*2))
                rr = ppe.predict(up, imgsz=640, conf=0.28, verbose=False)[0]
                for b in rr.boxes:
                    tgt = PPE_MAP.get(ppe.names[int(b.cls[0])])
                    if tgt is None: continue
                    bx1,by1,bx2,by2 = b.xyxy[0].tolist()
                    fx1,fy1,fx2,fy2 = X1+bx1/2, Y1+by1/2, X1+bx2/2, Y1+by2/2
                    lines.append(f"{tgt} {(fx1+fx2)/2/W:.6f} {(fy1+fy2)/2/H:.6f} {(fx2-fx1)/W:.6f} {(fy2-fy1)/H:.6f}")
            base = "site_" + os.path.basename(os.path.splitext(ip)[0])[:38]
            cv2.imwrite(f"{POOL}/{base}.jpg", frame)
            open(f"{POOL}/{base}.txt","w").write("\n".join(lines))
        print(f"[site] auto-labeled {len(imgs)}")

# --------------------------- 4) merge + split + yaml -------------------------
def split_and_yaml():
    for s in ("images/train","images/val","labels/train","labels/val"):
        os.makedirs(f"{DATA}/{s}", exist_ok=True)
    pairs = [(i, os.path.splitext(i)[0]+".txt") for i in glob.glob(f"{POOL}/*.jpg")
             if os.path.exists(os.path.splitext(i)[0]+".txt")]
    random.shuffle(pairs)
    n_val = int(len(pairs)*VAL_RATIO)
    for idx,(img,txt) in enumerate(pairs):
        sp = "val" if idx < n_val else "train"
        b = os.path.basename(img)
        shutil.copy(img, f"{DATA}/images/{sp}/{b}")
        shutil.copy(txt, f"{DATA}/labels/{sp}/{b[:-4]}.txt")
    yaml = f"{DATA}/data.yaml"
    with open(yaml,"w") as f:
        f.write(f"path: {DATA}\ntrain: images/train\nval: images/val\nnames:\n")
        for i,c in enumerate(CLASSES): f.write(f"  {i}: {c}\n")
    print(f"\n[merge] total={len(pairs)} train={len(pairs)-n_val} val={n_val}")
    # class distribution
    from collections import Counter
    cnt = Counter()
    for _,t in pairs:
        for l in open(t):
            if l.split(): cnt[int(l.split()[0])] += 1
    print("[merge] class counts:", {CLASSES[k]:v for k,v in sorted(cnt.items())})
    return yaml

# --------------------------- 5) train ----------------------------------------
def train(yaml):
    from ultralytics import YOLO
    import torch
    device = 0 if torch.cuda.is_available() else "cpu"
    print(f"\n[train] device={device}  model={MODEL}  imgsz={IMGSZ}  epochs={EPOCHS}")
    if device == "cpu":
        print("[train] WARNING: no GPU detected — this will be slow. Enable GPU accelerator.")
    m = YOLO(MODEL)
    m.train(data=yaml, epochs=EPOCHS, imgsz=IMGSZ, batch=BATCH, device=device,
            patience=PATIENCE, optimizer="auto", seed=42, save_period=10,
            project=RUNS, name="ppe_person", exist_ok=True, plots=True)
    best = f"{RUNS}/ppe_person/weights/best.pt"
    if os.path.exists(best):
        shutil.copy(best, f"{WORK}/ppe_person_best.pt")
        print(f"\n[done] BEST MODEL -> {WORK}/ppe_person_best.pt")
        mm = YOLO(best); met = mm.val(data=yaml, imgsz=IMGSZ, device=device, verbose=False)
        print(f"[done] val mAP50={met.box.map50:.3f}  mAP50-95={met.box.map:.3f}")
    else:
        print("[done] WARNING: best.pt not found — check logs")

def main():
    ensure_deps()
    os.makedirs(POOL, exist_ok=True)
    fetch_hf()
    fetch_bidjoe()
    add_site()
    yaml = split_and_yaml()
    train(yaml)

if __name__ == "__main__":
    main()
