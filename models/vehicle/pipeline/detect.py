"""Stage 1: detection + tracking on RF-DETR (ONNX) — no ultralytics.

WHY THIS IS NOT ULTRALYTICS ANY MORE
    Ultralytics YOLO is AGPL-3.0 and their licence covers "the training code AND
    the models produced by that training code". Distributing it obliges us to
    hand every client the complete source of the whole VMS. RF-DETR is
    Apache-2.0, onnxruntime is MIT, supervision is MIT — all shippable.

Runtime is pure ONNX: no torch, no rfdetr package. That also makes CPU
inference lighter than the torch path.

Raw model output is not the answer. Applied here, in order:
  1. per-class confidence  -> rare classes need a lower bar than common ones
  2. class-agnostic NMS    -> one box per physical vehicle, not one per class
  3. geometry gate         -> reject degenerate/fused boxes by aspect + size
Tracking is supervision's ByteTrack; the per-track class vote is temporal.py.
"""
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

# RF-DETR preprocessing, taken from rfdetr/detr.py (ImageNet statistics).
# Getting these wrong degrades detections silently rather than erroring.
MEANS = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STDS = np.array([0.229, 0.224, 0.225], dtype=np.float32)


@dataclass
class Detection:
    track_id: int
    cls_id: int
    cls_name: str
    conf: float
    bbox: tuple          # (x1, y1, x2, y2) ints, original-image pixels

    @property
    def centroid(self) -> tuple:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """Class-AGNOSTIC NMS.

    Ordinary per-class NMS lets one vehicle keep a `car` box and a `van` box
    simultaneously — both survive because they are different classes. Running it
    across all classes forces one box per physical object, which is the main fix
    for two conflicting labels stacked on one vehicle.
    """
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[order[1:]] - inter
        iou = np.where(union > 0, inter / union, 0.0)
        order = order[1:][iou <= iou_thr]
    return keep


class VehicleDetector:
    def __init__(self, model_path, classes, conf_floor, iou, imgsz,
                 agnostic_nms, tracker, per_class_conf, ar_bounds, min_size_px,
                 providers=None, track_activation=0.25, lost_track_buffer=30,
                 minimum_matching_threshold=0.8, frame_rate=10):
        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        # RF-DETR exports a FIXED square input (512 for Small); the resolution is
        # baked into the graph, so read it rather than trusting a config value.
        shape = self.session.get_inputs()[0].shape
        self.net_h = int(shape[2]) if isinstance(shape[2], int) else imgsz
        self.net_w = int(shape[3]) if isinstance(shape[3], int) else imgsz

        self.classes = classes
        self.conf_floor = conf_floor
        self.iou = iou
        self.agnostic_nms = agnostic_nms
        self.per_class_conf = per_class_conf
        self.ar_bounds = ar_bounds
        self.min_size_px = min_size_px
        self.rejected = {"conf": 0, "geometry": 0, "background": 0}

        # supervision's ByteTrack (MIT). Replaces ultralytics' bundled copy.
        # The deprecation warning is expected and handled by pinning
        # supervision<0.31 in requirements.txt — silenced so it does not spam
        # one line per worker start across every camera.
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            from supervision import ByteTrack, Detections  # noqa: F401
        self._Detections = Detections
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            self.tracker = ByteTrack(
                track_activation_threshold=track_activation,
                lost_track_buffer=lost_track_buffer,
                minimum_matching_threshold=minimum_matching_threshold,
                frame_rate=frame_rate,
            )

    # ---------------- pre/post ----------------
    def _preprocess(self, frame) -> np.ndarray:
        """BGR frame -> NCHW float32, normalised the way RF-DETR trained.

        The network takes a fixed SQUARE input, and training resized the same
        way (square resize, not letterbox), so aspect distortion here matches
        training and boxes map back with a plain per-axis scale.
        """
        img = cv2.resize(frame, (self.net_w, self.net_h), interpolation=cv2.INTER_LINEAR)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        img = (img - MEANS) / STDS
        return np.expand_dims(np.transpose(img, (2, 0, 1)), 0).astype(np.float32)

    def _postprocess(self, dets, logits, W, H):
        """RF-DETR head -> (boxes_xyxy, scores, class_ids) in source pixels.

        Output contract (verified against rfdetr's PostProcess and lwdetr.py):
          dets   (1, Q, 4)      normalised cxcywh
          logits (1, Q, C+1)    C real classes + ONE BACKGROUND slot at index C
        Scores are sigmoid (focal-loss DETR), not softmax, and the top-k is taken
        over the flattened query x class grid — one query can therefore yield
        several class hypotheses.
        """
        boxes = dets[0]                       # (Q,4) cxcywh normalised
        prob = 1.0 / (1.0 + np.exp(-logits[0]))   # sigmoid -> (Q, C+1)
        n_cls = prob.shape[1]

        flat = prob.reshape(-1)
        k = min(300, flat.size)
        # argpartition then sort only the top-k: full sort of Q*C is wasted work
        idx = np.argpartition(-flat, k - 1)[:k]
        idx = idx[np.argsort(-flat[idx])]

        scores = flat[idx]
        query_idx = idx // n_cls
        class_idx = idx % n_cls

        # Drop the background slot — it is a real output column, not a class.
        real = class_idx < len(self.classes)
        self.rejected["background"] += int((~real).sum())
        scores, query_idx, class_idx = scores[real], query_idx[real], class_idx[real]

        keep = scores >= self.conf_floor
        scores, query_idx, class_idx = scores[keep], query_idx[keep], class_idx[keep]
        if scores.size == 0:
            return np.zeros((0, 4), np.float32), scores, class_idx

        b = boxes[query_idx]
        cx, cy, w, h = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
        xyxy = np.stack([(cx - w / 2) * W, (cy - h / 2) * H,
                         (cx + w / 2) * W, (cy + h / 2) * H], axis=1)
        np.clip(xyxy[:, [0, 2]], 0, W, out=xyxy[:, [0, 2]])
        np.clip(xyxy[:, [1, 3]], 0, H, out=xyxy[:, [1, 3]])
        return xyxy.astype(np.float32), scores, class_idx

    def _passes_geometry(self, name, bbox) -> bool:
        x1, y1, x2, y2 = bbox
        w, h = x2 - x1, y2 - y1
        if w <= 0 or h <= 0:
            return False
        if (w * h) ** 0.5 < self.min_size_px:
            return False
        lo, hi = self.ar_bounds.get(name, (0.0, 99.0))
        return lo <= (w / h) <= hi

    # ---------------- public ----------------
    def infer(self, frame) -> list[Detection]:
        H, W = frame.shape[:2]
        dets, logits = self.session.run(None, {self.input_name: self._preprocess(frame)})
        xyxy, scores, class_ids = self._postprocess(dets, logits, W, H)

        if len(xyxy) and self.agnostic_nms:
            keep = _nms(xyxy, scores, self.iou)
            xyxy, scores, class_ids = xyxy[keep], scores[keep], class_ids[keep]

        # Per-class confidence + geometry, BEFORE tracking: feeding junk to the
        # tracker creates junk tracks that the class voter then has to unlearn.
        sel = []
        for i, (b, s, c) in enumerate(zip(xyxy, scores, class_ids)):
            name = self.classes[int(c)]
            if s < self.per_class_conf.get(name, 0.35):
                self.rejected["conf"] += 1
                continue
            if not self._passes_geometry(name, b):
                self.rejected["geometry"] += 1
                continue
            sel.append(i)

        if not sel:
            self.tracker.update_with_detections(self._Detections.empty())
            return []

        xyxy, scores, class_ids = xyxy[sel], scores[sel], class_ids[sel]
        tracked = self.tracker.update_with_detections(
            self._Detections(xyxy=xyxy, confidence=scores,
                             class_id=class_ids.astype(int))
        )

        out = []
        for i in range(len(tracked.xyxy)):
            x1, y1, x2, y2 = (int(v) for v in tracked.xyxy[i])
            cid = int(tracked.class_id[i])
            tid = int(tracked.tracker_id[i]) if tracked.tracker_id is not None else -1
            out.append(Detection(tid, cid, self.classes[cid],
                                 float(tracked.confidence[i]), (x1, y1, x2, y2)))
        return out
