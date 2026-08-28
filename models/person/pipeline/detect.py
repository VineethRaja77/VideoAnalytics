"""Person detection + tracking — RF-DETR COCO-pretrained on ONNX.

NO TRAINING WAS REQUIRED. `person` is COCO class 1, so the stock Apache-2.0
RF-DETR checkpoint already detects it; we only export it to ONNX and filter to
that one class. That is what makes seven analytics buildable with no dataset,
no GPU and no Kaggle run.

Licence chain, all shippable in a closed-source commercial product:
    RF-DETR weights  Apache-2.0      DINOv2 backbone  Apache-2.0
    onnxruntime      MIT             supervision      MIT

Output contract (verified against the exported graph and rfdetr's PostProcess):
    dets   (1, Q, 4)     normalised cxcywh
    labels (1, Q, C+1)   C COCO classes + ONE background slot
    class index == COCO category_id, so person is index 1 — confirmed
    empirically (person 0.887 / car 0.925 / motorcycle on a real frame).
"""
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

MEANS = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STDS = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# COCO category id for "person" in the RF-DETR COCO checkpoint.
PERSON_CLASS_ID = 1


@dataclass
class Track:
    track_id: int
    conf: float
    bbox: tuple      # (x1, y1, x2, y2) ints in source-image pixels

    @property
    def centroid(self) -> tuple:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
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


class PersonDetector:
    def __init__(self, model_path, conf=0.4, iou=0.6, min_height_px=40,
                 max_aspect=2.5, providers=None, track_activation=0.25,
                 lost_track_buffer=60, minimum_matching_threshold=0.8,
                 frame_rate=6):
        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        # RF-DETR bakes a fixed square input into the graph — read it.
        self.net_h = int(shape[2]) if isinstance(shape[2], int) else 512
        self.net_w = int(shape[3]) if isinstance(shape[3], int) else 512

        self.conf = conf
        self.iou = iou
        self.min_height_px = min_height_px
        self.max_aspect = max_aspect
        self.rejected = {"conf": 0, "size": 0, "aspect": 0, "not_person": 0}

        import warnings
        with warnings.catch_warnings():
            # supervision deprecated ByteTrack in 0.28 (removal 0.31) with no
            # replacement; requirements pins <0.31. Silenced so it does not log
            # once per worker start on every camera.
            warnings.simplefilter("ignore", FutureWarning)
            from supervision import ByteTrack, Detections
            self._Detections = Detections
            self.tracker = ByteTrack(
                track_activation_threshold=track_activation,
                # People stand still and occlude each other far more than
                # vehicles, so the track buffer is longer than the vehicle
                # module's — losing an id resets every dwell timer.
                lost_track_buffer=lost_track_buffer,
                minimum_matching_threshold=minimum_matching_threshold,
                frame_rate=frame_rate,
            )

    def _preprocess(self, frame) -> np.ndarray:
        img = cv2.resize(frame, (self.net_w, self.net_h), interpolation=cv2.INTER_LINEAR)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        img = (img - MEANS) / STDS
        return np.expand_dims(np.transpose(img, (2, 0, 1)), 0).astype(np.float32)

    def _postprocess(self, dets, logits, W, H):
        boxes = dets[0]
        prob = 1.0 / (1.0 + np.exp(-logits[0]))
        n_cls = prob.shape[1]

        flat = prob.reshape(-1)
        k = min(300, flat.size)
        idx = np.argpartition(-flat, k - 1)[:k]
        idx = idx[np.argsort(-flat[idx])]

        scores = flat[idx]
        query_idx = idx // n_cls
        class_idx = idx % n_cls

        # Person only. Every other COCO class is a valid detection we simply do
        # not want, so it is counted rather than silently dropped.
        is_person = class_idx == PERSON_CLASS_ID
        self.rejected["not_person"] += int((~is_person).sum())
        scores, query_idx = scores[is_person], query_idx[is_person]

        keep = scores >= self.conf
        self.rejected["conf"] += int((~keep).sum())
        scores, query_idx = scores[keep], query_idx[keep]
        if scores.size == 0:
            return np.zeros((0, 4), np.float32), scores

        b = boxes[query_idx]
        cx, cy, w, h = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
        xyxy = np.stack([(cx - w / 2) * W, (cy - h / 2) * H,
                         (cx + w / 2) * W, (cy + h / 2) * H], axis=1)
        np.clip(xyxy[:, [0, 2]], 0, W, out=xyxy[:, [0, 2]])
        np.clip(xyxy[:, [1, 3]], 0, H, out=xyxy[:, [1, 3]])
        return xyxy.astype(np.float32), scores

    def _passes_geometry(self, box) -> bool:
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        if h < self.min_height_px:
            self.rejected["size"] += 1
            return False
        # A person box far wider than tall is usually two people merged or a
        # reflection. NOTE: the fall rule needs wide boxes, so this bound is
        # deliberately generous rather than "taller than wide".
        if h > 0 and (w / h) > self.max_aspect:
            self.rejected["aspect"] += 1
            return False
        return True

    def infer(self, frame) -> list[Track]:
        H, W = frame.shape[:2]
        dets, logits = self.session.run(None, {self.input_name: self._preprocess(frame)})
        xyxy, scores = self._postprocess(dets, logits, W, H)

        if len(xyxy):
            keep = _nms(xyxy, scores, self.iou)
            xyxy, scores = xyxy[keep], scores[keep]

        sel = [i for i, b in enumerate(xyxy) if self._passes_geometry(b)]
        if not sel:
            self.tracker.update_with_detections(self._Detections.empty())
            return []
        xyxy, scores = xyxy[sel], scores[sel]

        tracked = self.tracker.update_with_detections(
            self._Detections(xyxy=xyxy, confidence=scores,
                             class_id=np.zeros(len(xyxy), dtype=int))
        )

        out = []
        for i in range(len(tracked.xyxy)):
            x1, y1, x2, y2 = (int(v) for v in tracked.xyxy[i])
            tid = int(tracked.tracker_id[i]) if tracked.tracker_id is not None else -1
            out.append(Track(tid, float(tracked.confidence[i]), (x1, y1, x2, y2)))
        return out
