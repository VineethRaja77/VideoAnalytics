"""Stage 7: run the LOCKED trained model on a 1-minute clip and save annotated video.

The trained model is the single Person+PPE detector (9 classes). This is a quick
"does it work" check on real footage — draws every detection with a per-class
color and writes to outputs/trained_model_test.mp4.
"""
import os, cv2
from ultralytics import YOLO

MODEL = "../locked/ppe_person_best.pt"
VIDEO = "/home/hyperspark/VMS/VMS/VMS_PRODUCTION/data/PPE FILES/NVR_ch13_main_20260404160000_20260404170117.mp4"
OUT = "/home/hyperspark/VMS/VMS/VMS_PRODUCTION/outputs/trained_model_test.mp4"
STRIDE = 12
MAX_FRAMES = 130      # ~1 minute at stride 12 on 25fps
OUT_W = 1280
CONF = 0.30

COLORS = {
    "person": (200, 200, 200),
    "helmet": (0, 180, 0), "no_helmet": (0, 0, 255),
    "vest": (0, 200, 220), "no_vest": (0, 0, 200),
    "gloves": (255, 120, 0), "no_gloves": (0, 60, 255),
    "boots": (255, 0, 255), "no_boots": (0, 0, 160),
}

if not os.path.exists(MODEL):
    raise SystemExit(f"locked model not found: {MODEL}")
model = YOLO(MODEL)
print("[test] classes:", model.names)

cap = cv2.VideoCapture(VIDEO)
src_fps = cap.get(cv2.CAP_PROP_FPS) or 25
src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
out_h = int(src_h * OUT_W / src_w)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
writer = cv2.VideoWriter(OUT, cv2.VideoWriter_fourcc(*"mp4v"), max(1.0, src_fps / STRIDE), (OUT_W, out_h))

idx = 0; processed = 0; counts = {}
while processed < MAX_FRAMES:
    if not cap.grab():
        break
    if idx % STRIDE:
        idx += 1; continue
    ok, frame = cap.retrieve(); idx += 1
    if not ok:
        break
    r = model.predict(frame, imgsz=1280, conf=CONF, verbose=False)[0]
    for b in r.boxes:
        cls = model.names[int(b.cls[0])]; conf = float(b.conf[0])
        counts[cls] = counts.get(cls, 0) + 1
        x1, y1, x2, y2 = [int(v) for v in b.xyxy[0].tolist()]
        c = COLORS.get(cls, (255, 255, 0))
        cv2.rectangle(frame, (x1, y1), (x2, y2), c, 2)
        cv2.putText(frame, f"{cls} {conf:.2f}", (x1, max(12, y1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 2)
    out = cv2.resize(frame, (OUT_W, out_h))
    cv2.putText(out, f"frame {processed}", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    writer.write(out)
    processed += 1
cap.release(); writer.release()
print(f"[test done] {processed} frames -> {OUT}")
print(f"[test done] detections by class: {counts}")
