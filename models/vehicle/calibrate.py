#!/usr/bin/env python3
"""Generate vehicle_profile.json from the trained RF-DETR ONNX model.

THRESHOLDS ARE MODEL-SPECIFIC. The profile produced for the old YOLO weights
does NOT transfer to RF-DETR: the two score distributions are different (focal
sigmoid over 300 queries vs YOLO objectness), so a 0.49 that meant "confident"
for YOLO means something else here. Re-run this after every training run.

What it produces, per class:
  * F1-optimal confidence threshold, swept against the validation set
  * aspect-ratio / min-size reject bounds measured from the labels

    python calibrate.py --images 1500

Runs on CPU via onnxruntime — no torch, no ultralytics.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = "iisc-aim/BMD-45"
FOLDER = "BMD-45-Val"
MAX_SIDE = 1280
JPEG_Q = 88

CLASSES = ["two_wheeler", "three_wheeler", "car", "van", "lcv",
           "truck", "bus", "bicycle"]

BMD_TO_OURS = {
    "twowheeler": 0, "threewheeler": 1,
    "hatchback": 2, "sedan": 2, "suv": 2, "muv": 2,
    "van": 3, "lcv": 4, "tempotraveller": 4,
    "truck": 5, "bus": 6, "minibus": 6, "bicycle": 7,
}


def norm_key(s):
    return "".join(c for c in str(s).lower() if c.isalnum())


def pct(vals, q):
    if not vals:
        return None
    v = sorted(vals)
    return v[max(0, min(len(v) - 1, int(q * len(v))))]


def iou_matrix(a, b):
    """IoU of every box in `a` against every box in `b`."""
    import numpy as np
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), dtype=np.float32)
    ax1, ay1, ax2, ay2 = a[:, 0:1], a[:, 1:2], a[:, 2:3], a[:, 3:4]
    bx1, by1, bx2, by2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    ix1, iy1 = np.maximum(ax1, bx1), np.maximum(ay1, by1)
    ix2, iy2 = np.minimum(ax2, bx2), np.minimum(ay2, by2)
    inter = np.clip(ix2 - ix1, 0, None) * np.clip(iy2 - iy1, 0, None)
    area_a = np.clip(ax2 - ax1, 0, None) * np.clip(ay2 - ay1, 0, None)
    area_b = np.clip(bx2 - bx1, 0, None) * np.clip(by2 - by1, 0, None)
    union = area_a + area_b - inter
    return np.where(union > 0, inter / union, 0.0)


def build_valset(out_dir, cap):
    """Fetch a slice of BMD-45 val as images + per-image GT boxes."""
    from huggingface_hub import hf_hub_download
    from PIL import Image

    os.makedirs(out_dir, exist_ok=True)
    gt_path = os.path.join(out_dir, "gt.json")
    if os.path.exists(gt_path):
        print(f"[calib] reusing cached val set at {out_dir}")
        return json.load(open(gt_path))

    ann = hf_hub_download(REPO, f"{FOLDER}/_annotations.coco.json", repo_type="dataset")
    coco = json.load(open(ann))
    id2name = {c["id"]: c["name"] for c in coco["categories"]}

    per_img = defaultdict(list)
    for a in coco["annotations"]:
        t = BMD_TO_OURS.get(norm_key(id2name.get(a["category_id"], "")))
        if t is not None:
            per_img[a["image_id"]].append((t, a["bbox"]))

    imgs = [im for im in coco["images"] if per_img.get(im["id"])][:cap]
    print(f"[calib] fetching {len(imgs)} val images ...")
    gt = {}

    def grab(im):
        base = f"val_{im['id']}.jpg"
        dst = os.path.join(out_dir, base)
        png = None
        try:
            if not os.path.exists(dst):
                png = hf_hub_download(REPO, f"{FOLDER}/{im['file_name']}", repo_type="dataset")
                with Image.open(png) as p:
                    p = p.convert("RGB")
                    ow, oh = p.size
                    s = MAX_SIDE / float(max(p.size)) if max(p.size) > MAX_SIDE else 1.0
                    if s < 1.0:
                        p = p.resize((int(ow * s), int(oh * s)))
                    p.save(dst, quality=JPEG_Q)
                    nw, nh = p.size
            else:
                with Image.open(dst) as p:
                    nw, nh = p.size
                s = nw / float(im["width"])
            boxes = []
            for cls, bb in per_img[im["id"]]:
                x, y, w, h = (v * s for v in bb)
                if w > 1 and h > 1:
                    boxes.append([cls, x, y, x + w, y + h])
            return base, boxes
        except Exception as e:
            print(f"   fetch fail: {type(e).__name__}")
            return None
        finally:
            if png and os.path.exists(png):
                try:
                    os.remove(png)
                except Exception:
                    pass

    with ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(grab, imgs):
            if r:
                gt[r[0]] = r[1]
    json.dump(gt, open(gt_path, "w"))
    print(f"[calib] val set ready: {len(gt)} images")
    return gt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", type=int, default=1500)
    ap.add_argument("--model", default="weights/vehicle_rfdetr.onnx")
    ap.add_argument("--workdir", default="calib_data")
    ap.add_argument("--out", default="vehicle_profile.json")
    ap.add_argument("--iou", type=float, default=0.5, help="IoU for a true positive")
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    model = a.model if os.path.isabs(a.model) else os.path.join(here, a.model)
    workdir = os.path.join(here, a.workdir)
    if not os.path.exists(model):
        sys.exit(f"missing model: {model}\nExport it after training: model.export(output_dir='weights')")

    gt = build_valset(workdir, a.images)

    import cv2
    import numpy as np
    from pipeline.detect import VehicleDetector

    # Wide-open thresholds: calibration must see the full score range, so no
    # per-class conf, no geometry gate, no NMS-driven suppression of the very
    # detections we are trying to characterise.
    det = VehicleDetector(model, CLASSES, 0.01, 0.6, 512, True, None,
                          {c: 0.0 for c in CLASSES},
                          {c: (0.0, 99.0) for c in CLASSES}, 0.0)

    # score buckets per class: (score, is_true_positive)
    samples = defaultdict(list)
    n_gt = defaultdict(int)
    ar, size = defaultdict(list), defaultdict(list)

    print(f"[calib] scoring {len(gt)} images (CPU) ...")
    for i, (fn, boxes) in enumerate(gt.items()):
        frame = cv2.imread(os.path.join(workdir, fn))
        if frame is None:
            continue
        H, W = frame.shape[:2]

        gt_by_cls = defaultdict(list)
        for cls, x1, y1, x2, y2 in boxes:
            gt_by_cls[cls].append([x1, y1, x2, y2])
            n_gt[cls] += 1
            w, h = x2 - x1, y2 - y1
            if w > 0 and h > 0:
                ar[CLASSES[cls]].append(w / h)
                size[CLASSES[cls]].append((w * h) ** 0.5)

        dets, logits = det.session.run(None, {det.input_name: det._preprocess(frame)})
        xyxy, scores, cls_ids = det._postprocess(dets, logits, W, H)

        for c in set(cls_ids.tolist()):
            m = cls_ids == c
            pb, ps = xyxy[m], scores[m]
            order = ps.argsort()[::-1]
            pb, ps = pb[order], ps[order]
            g = np.array(gt_by_cls.get(int(c), []), dtype=np.float32)
            used = set()
            if len(g):
                M = iou_matrix(pb, g)
                for k in range(len(pb)):
                    j = int(np.argmax(M[k])) if M.shape[1] else -1
                    # Greedy match, best-IoU first, each GT box claimed once —
                    # otherwise several predictions on one vehicle all count as
                    # true positives and the threshold comes out too low.
                    hit = j >= 0 and M[k, j] >= a.iou and j not in used
                    if hit:
                        used.add(j)
                    samples[CLASSES[int(c)]].append((float(ps[k]), hit))
            else:
                for k in range(len(pb)):
                    samples[CLASSES[int(c)]].append((float(ps[k]), False))

        if (i + 1) % 200 == 0:
            print(f"   {i + 1}/{len(gt)}", flush=True)

    # ---- sweep for the F1-optimal threshold per class ----
    conf, report = {}, {}
    for ci, name in enumerate(CLASSES):
        rows = sorted(samples.get(name, []), key=lambda r: -r[0])
        total_gt = n_gt.get(ci, 0)
        if not rows or total_gt == 0:
            conf[name] = 0.35
            report[name] = None
            continue
        tp = 0
        best = (0.0, 0.35, 0.0, 0.0)   # f1, thr, precision, recall
        for k, (s, hit) in enumerate(rows, start=1):
            tp += 1 if hit else 0
            prec = tp / k
            rec = tp / total_gt
            f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
            if f1 > best[0]:
                best = (f1, s, prec, rec)
        # Clamp: a peak under 0.15 means the class was barely learned; shipping
        # it would flood the runtime with false positives on unseen cameras.
        conf[name] = round(min(max(best[1], 0.15), 0.75), 3)
        report[name] = {"f1": round(best[0], 3), "precision": round(best[2], 3),
                        "recall": round(best[3], 3), "gt": total_gt}

    geo = {}
    for c in CLASSES:
        v, s = ar[c], size[c]
        if not v:
            continue
        geo[c] = {
            "n": len(v),
            "ar_median": round(pct(v, .50), 3),
            "ar_p5": round(pct(v, .05), 3),
            "ar_p95": round(pct(v, .95), 3),
            "ar_reject_below": round(pct(v, .01), 3),
            "ar_reject_above": round(pct(v, .99), 3),
            "size_median": round(pct(s, .50), 1),
            "min_size_px": round(pct(s, .05), 1),
        }

    print(f"\n{'class':<15}{'conf':>7}{'F1':>7}{'prec':>7}{'rec':>7}"
          f"{'ARmed':>8}{'minpx':>7}{'gt':>8}")
    for c in CLASSES:
        r = report.get(c) or {}
        g = geo.get(c, {})
        print(f"{c:<15}{conf[c]:>7.3f}{r.get('f1','-'):>7}{r.get('precision','-'):>7}"
              f"{r.get('recall','-'):>7}{g.get('ar_median','-'):>8}"
              f"{g.get('min_size_px','-'):>7}{r.get('gt','-'):>8}")

    profile = {
        "model": os.path.basename(model),
        "backend": "onnxruntime",
        "imgsz": det.net_w,
        "classes": CLASSES,
        "calibratedOn": {"dataset": "BMD-45 val", "images": len(gt), "iou": a.iou},
        "conf_threshold": conf,
        "per_class_report": report,
        "global_conf_floor": round(min(conf.values()), 3) if conf else 0.25,
        "iou_nms": 0.6,
        "geometry": geo,
        "notes": {
            "model_specific": "Thresholds do NOT transfer between architectures. "
                              "Re-run calibrate.py after every training run.",
            "geometry": "AR bounds are p1/p99 — an outlier gate ONLY. Never use "
                        "aspect ratio to decide class: across camera angles the "
                        "per-class ranges overlap almost completely.",
            "daylight_only": "BMD-45 is 06:00-18:00; optimistic at night.",
        },
    }
    out = os.path.join(here, a.out)
    json.dump(profile, open(out, "w"), indent=2)
    print(f"\n[calib] wrote {out}")
    print("[calib] config.py picks this up automatically — no code change needed")


if __name__ == "__main__":
    main()
