"""Stage 1+6: person + PPE detection in ONE pass, on RF-DETR (ONNX).

WHY THIS IS NOT ULTRALYTICS ANY MORE
    Ultralytics YOLO is AGPL-3.0 and their licence covers "the training code AND
    THE MODELS PRODUCED BY THAT TRAINING CODE". Exporting to ONNX does not
    escape it. Distributing an AGPL work entitles every recipient to the
    complete source of the whole application, which is incompatible with a
    closed-source commercial product.

    RF-DETR (Apache-2.0) + onnxruntime (MIT) + supervision (MIT) is shippable.
    Only Nano/Small/Medium/Large are Apache — never XLarge/2XLarge (PML-1.0).

WHAT CHANGED FUNCTIONALLY
    The old pipeline ran a YOLO-POSE model for people (boxes + 17 COCO
    keypoints + tracking) and separate YOLO models for PPE. Keypoints drove
    `visibility.py`, which is the safety property that matters: a body part that
    is not visible is reported "not visible", never "missing".

    RF-DETR produces boxes only. The replacement therefore derives body regions
    from PERSON BOX GEOMETRY, and — critically — keeps the conservative rule:
    an item is only "missing" when the model EXPLICITLY detects a negative class
    (no_helmet / no_vest / no_boots) on the right region. Absence of a positive
    detection is still "unknown", never a violation. See association.py.

    Tracking moves to supervision's ByteTrack (MIT), same tracker Ultralytics
    bundled, just used directly.

MODEL CONTRACT (verified against the exported file)
    input   (1, 3, 672, 672)  RGB, ImageNet-normalised
    dets    (1, 300, 4)       cxcywh, normalised 0-1
    labels  (1, 300, C+1)     C real classes + ONE BACKGROUND slot at index C
    Scores are sigmoid (focal-loss DETR), not softmax.
"""
import os
import warnings
from dataclasses import dataclass, field

import cv2
import numpy as np
import onnxruntime as ort

MEANS = np.array([0.485, 0.456, 0.406], np.float32)
STDS = np.array([0.229, 0.224, 0.225], np.float32)


@dataclass
class Person:
    """Kept name-compatible with the old PersonPose output.

    `keypoints` is retained but ALWAYS EMPTY: RF-DETR has no pose head. Callers
    must not infer visibility from it — visibility.py now works from the box.
    """
    track_id: int
    bbox: list                                      # [x1,y1,x2,y2] full-frame
    conf: float
    keypoints: dict = field(default_factory=dict)   # always {} — no pose head


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """Plain greedy NMS. DETR emits one box per query with no duplicate
    suppression of its own, and the top-k is taken over the flattened
    query x class grid, so one object can surface several times."""
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


class PPEDetector:
    """One model, both jobs: people and PPE items.

    Replaces the old ensemble of separate hardhat/vest models. A single trained
    model with explicit negative classes is strictly better than inferring
    absence from silence — it can say "this head has no helmet" rather than
    "no helmet was detected anywhere", which is what produced false violations
    on small or distant workers.
    """

    def __init__(self, model_path, classes, conf: float, iou: float,
                 per_class_conf=None, providers=None,
                 track_activation=0.25, lost_track_buffer=30,
                 minimum_matching_threshold=0.8, frame_rate=6):
        # Accept the legacy list form so an old config does not hard-fail.
        if isinstance(model_path, (list, tuple)):
            model_path = model_path[0] if model_path else ""

        self.classes = list(classes)
        self.conf = conf
        self.iou = iou
        self.per_class_conf = per_class_conf or {}
        self.available = bool(model_path) and os.path.exists(model_path)

        if not self.available:
            print(f"[ppe_detect] model not found at '{model_path}' — PPE items will "
                  f"report 'unknown'. Nothing downstream will fabricate a violation.")
            self.session = None
            return

        self.session = ort.InferenceSession(
            model_path, providers=providers or ["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        # Read the resolution FROM THE MODEL. Hard-coding it is how a 672px
        # export silently gets fed 512px input and quietly loses accuracy.
        self.net_h = int(shape[2]) if isinstance(shape[2], int) else 672
        self.net_w = int(shape[3]) if isinstance(shape[3], int) else 672

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            from supervision import ByteTrack
            self.tracker = ByteTrack(
                track_activation_threshold=track_activation,
                lost_track_buffer=lost_track_buffer,
                minimum_matching_threshold=minimum_matching_threshold,
                frame_rate=frame_rate,
            )
        print(f"[ppe_detect] loaded {model_path} @ {self.net_w}x{self.net_h} "
              f"classes={self.classes}")

    # ---------------- pre/post ----------------
    def _preprocess(self, frame) -> np.ndarray:
        """BGR frame -> NCHW float32, normalised the way RF-DETR trained.

        Square resize, not letterbox — training resized the same way, so the
        aspect distortion matches and boxes map back with a per-axis scale.
        """
        img = cv2.resize(frame, (self.net_w, self.net_h), interpolation=cv2.INTER_LINEAR)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        img = (img - MEANS) / STDS
        return np.expand_dims(np.transpose(img, (2, 0, 1)), 0).astype(np.float32)

    def _postprocess(self, dets, logits, W, H):
        boxes = dets[0]
        prob = 1.0 / (1.0 + np.exp(-logits[0]))     # sigmoid, focal-loss DETR
        n_cls = prob.shape[1]

        flat = prob.reshape(-1)
        k = min(300, flat.size)
        idx = np.argpartition(-flat, k - 1)[:k]
        idx = idx[np.argsort(-flat[idx])]

        scores = flat[idx]
        query_idx = idx // n_cls
        class_idx = idx % n_cls

        # Drop the background slot — it is a real output column, not a class.
        real = class_idx < len(self.classes)
        scores, query_idx, class_idx = scores[real], query_idx[real], class_idx[real]

        # Per-class floor: negative classes train under-confident and need a
        # lower bar than the abundant positive ones.
        thr = np.array([self.per_class_conf.get(self.classes[c], self.conf)
                        for c in class_idx], np.float32) if scores.size else np.array([])
        keep = scores >= thr if scores.size else np.array([], bool)
        scores, query_idx, class_idx = scores[keep], query_idx[keep], class_idx[keep]
        if scores.size == 0:
            return np.zeros((0, 4), np.float32), scores, class_idx

        b = boxes[query_idx]
        cx, cy, w, h = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
        xyxy = np.stack([(cx - w / 2) * W, (cy - h / 2) * H,
                         (cx + w / 2) * W, (cy + h / 2) * H], axis=1)
        np.clip(xyxy[:, [0, 2]], 0, W, out=xyxy[:, [0, 2]])
        np.clip(xyxy[:, [1, 3]], 0, H, out=xyxy[:, [1, 3]])

        # NMS per class, so a helmet box never suppresses the person box it sits on.
        keep_idx = []
        for c in np.unique(class_idx):
            m = np.where(class_idx == c)[0]
            keep_idx.extend(m[i] for i in _nms(xyxy[m], scores[m], self.iou))
        keep_idx = np.array(sorted(keep_idx), int)
        return xyxy[keep_idx].astype(np.float32), scores[keep_idx], class_idx[keep_idx]

    # ---------------- public ----------------
    def infer(self, frame):
        """One pass -> (people, ppe_detections).

        people          : [Person] with stable ByteTrack ids
        ppe_detections  : [{class, conf, bbox}] for every non-person class,
                          in full-frame coordinates
        """
        if not self.available:
            return [], []

        H, W = frame.shape[:2]
        dets, logits = self.session.run(None, {self.input_name: self._preprocess(frame)})
        xyxy, scores, class_idx = self._postprocess(dets, logits, W, H)

        person_i = self.classes.index("person") if "person" in self.classes else -1
        people_mask = class_idx == person_i
        ppe_mask = ~people_mask

        # --- people through ByteTrack, so temporal voting has stable ids ---
        people = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            from supervision import Detections
            det = Detections(
                xyxy=xyxy[people_mask].astype(np.float32).reshape(-1, 4),
                confidence=scores[people_mask].astype(np.float32),
                class_id=class_idx[people_mask].astype(int),
            )
            tracked = self.tracker.update_with_detections(det)

        for i in range(len(tracked.xyxy)):
            tid = int(tracked.tracker_id[i]) if tracked.tracker_id is not None else -1
            people.append(Person(
                track_id=tid,
                bbox=[round(float(v)) for v in tracked.xyxy[i]],
                conf=float(tracked.confidence[i]) if tracked.confidence is not None else 0.0,
            ))

        ppe = [
            {"class": self.classes[int(c)], "conf": float(s),
             "bbox": [round(float(v)) for v in bb]}
            for bb, s, c in zip(xyxy[ppe_mask], scores[ppe_mask], class_idx[ppe_mask])
        ]
        return people, ppe

    def detect(self, frame) -> list[dict]:
        """Legacy shim: PPE-only, for callers that still expect the old API."""
        return self.infer(frame)[1]
