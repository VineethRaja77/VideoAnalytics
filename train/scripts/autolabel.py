"""Stage 3: auto-label the extracted frames into YOLO format (pseudo-labels).

Strategy (hybrid, tuned for small/distant CCTV workers):
  - yolo11n-pose gives high-quality PERSON boxes -> class 0.
  - For each person, run the YOLO11s PPE model on the UPSCALED person crop
    (much better on small gloves/boots), then map the PPE boxes back to
    full-frame coordinates and write them as PPE classes.

These labels are noisy by nature (that's expected for auto-labeling) — they give
the model a strong starting point; a later CVAT pass / active-learning corrects
the hard cases. Labels are written next to a mirror of the images so the merge
step can split them into train/val.

Out: train/frames_labeled/<name>.jpg  + train/frames_labeled/<name>.txt
"""
import os, glob, cv2
from ultralytics import YOLO

FRAMES = "../frames"
OUT = "../frames_labeled"
POSE_MODEL = "../../models/ppe/yolo11n-pose.pt"
PPE_MODEL = "../../models/ppe/weights/ppe_yolo11s.pt"
PPE_CONF = 0.28
PAD = 0.20

# YOLO11s (Sajjad) class id -> our 9-class schema id. Person comes from pose, so
# the PPE model's 'Person' is dropped here to avoid duplicate/again-lower-quality boxes.
PPE_MAP = {
    "Helmet": 1, "no_helmet": 2,
    "Vest": 3,               # this model has no 'no_vest' (comes from public data)
    "Gloves": 5, "no_gloves": 6,
    "Boots": 7, "no_boots": 8,
}

os.makedirs(OUT, exist_ok=True)
pose = YOLO(POSE_MODEL)
ppe = YOLO(PPE_MODEL)

imgs = sorted(glob.glob(f"{FRAMES}/*.jpg"))
print(f"[autolabel] {len(imgs)} frames  pose={os.path.basename(POSE_MODEL)} ppe={os.path.basename(PPE_MODEL)}")

def clip(v, lo, hi):
    return max(lo, min(hi, v))

done = 0
for ip in imgs:
    frame = cv2.imread(ip)
    if frame is None:
        continue
    H, W = frame.shape[:2]
    lines = []

    # 1) PERSON boxes from pose (class 0)
    pr = pose.predict(frame, imgsz=640, conf=0.40, classes=[0], verbose=False)[0]
    persons = []
    for b in pr.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        persons.append((x1, y1, x2, y2))
        cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
        bw, bh = (x2 - x1) / W, (y2 - y1) / H
        lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")

    # 2) PPE on each upscaled person crop, boxes mapped back to full frame
    for (x1, y1, x2, y2) in persons:
        pw, ph = x2 - x1, y2 - y1
        X1 = int(clip(x1 - PAD * pw, 0, W)); Y1 = int(clip(y1 - PAD * ph, 0, H))
        X2 = int(clip(x2 + PAD * pw, 0, W)); Y2 = int(clip(y2 + PAD * ph, 0, H))
        crop = frame[Y1:Y2, X1:X2]
        if crop.size == 0:
            continue
        ch, cw = crop.shape[:2]
        up = cv2.resize(crop, (cw * 2, ch * 2))
        rr = ppe.predict(up, imgsz=640, conf=PPE_CONF, verbose=False)[0]
        for b in rr.boxes:
            cls_name = ppe.names[int(b.cls[0])]
            tgt = PPE_MAP.get(cls_name)
            if tgt is None:
                continue
            bx1, by1, bx2, by2 = b.xyxy[0].tolist()
            # crop(2x) -> crop -> full frame
            fx1 = X1 + bx1 / 2; fy1 = Y1 + by1 / 2
            fx2 = X1 + bx2 / 2; fy2 = Y1 + by2 / 2
            cx, cy = (fx1 + fx2) / 2 / W, (fy1 + fy2) / 2 / H
            bw, bh = (fx2 - fx1) / W, (fy2 - fy1) / H
            if bw <= 0 or bh <= 0:
                continue
            lines.append(f"{tgt} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")

    name = os.path.splitext(os.path.basename(ip))[0]
    cv2.imwrite(f"{OUT}/{name}.jpg", frame)
    with open(f"{OUT}/{name}.txt", "w") as f:
        f.write("\n".join(lines))
    done += 1
    if done % 100 == 0:
        print(f"[autolabel] {done}/{len(imgs)}", flush=True)

print(f"[autolabel done] wrote {done} image+label pairs -> {OUT}/")
