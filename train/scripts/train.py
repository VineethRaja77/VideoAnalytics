"""Stage 6: train the one-model Person+PPE detector on CPU (safely).

CPU-only tuning:
  - yolo11n (nano) — smallest/fastest to train
  - imgsz 640 (keeps small gloves/boots detectable without exploding CPU cost)
  - RAM image cache (box has 31 GB) so epochs aren't disk-bound
  - early stopping (patience) so we don't waste hours after it converges
  - periodic checkpoints so a stop/restart never loses progress

Guards against overfitting/poor generalization:
  - strong augmentation (mosaic, hsv, flips, scale) is on by Ultralytics default
  - val split (15%) tracked every epoch; we keep best.pt by val mAP, not last.pt
After training, best.pt is copied to train/locked/ppe_person_best.pt (the "locked" model).
"""
import os, shutil
from ultralytics import YOLO

DATA = "../dataset/data.yaml"
BASE = "yolo11n.pt"          # Ultralytics auto-downloads if missing
PROJECT = "../runs"
NAME = "ppe_person_v1"
LOCKED = "../locked/ppe_person_best.pt"

os.makedirs("../locked", exist_ok=True)

model = YOLO(BASE)
results = model.train(
    data=DATA,
    epochs=60,
    imgsz=640,
    batch=16,
    device="cpu",
    workers=12,
    cache="disk",         # ~10k imgs: disk cache avoids any RAM pressure
    patience=12,          # early stop if val mAP stalls for 12 epochs (more data = fewer epochs)
    optimizer="auto",
    seed=42,
    save_period=10,       # checkpoint every 10 epochs (crash-safe)
    project=PROJECT,
    name=NAME,
    exist_ok=True,
    plots=True,
    amp=False,            # no benefit on CPU
    verbose=True,
)

best = os.path.join(PROJECT, NAME, "weights", "best.pt")
if os.path.exists(best):
    shutil.copy(best, LOCKED)
    print(f"\n[train done] LOCKED best model -> {LOCKED}")
    # quick val summary
    m = YOLO(best)
    metrics = m.val(data=DATA, imgsz=640, device="cpu", workers=4, verbose=False)
    print(f"[train done] val mAP50={metrics.box.map50:.3f}  mAP50-95={metrics.box.map:.3f}")
else:
    print("[train] WARNING: best.pt not found — check the run logs")
