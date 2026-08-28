"""Abandoned / removed object detection — no AI model.

The classic dual-background method, which needs no training and no weights:

    BG_slow   learns the scene slowly. A bag put down stays "foreground" here
              for a long time, because the model has not absorbed it yet.
    BG_fast   learns quickly. The same bag becomes "background" within seconds
              once it stops moving.

    static = foreground(slow) AND background(fast)

That intersection is exactly "something that arrived and then stopped moving" —
a person walking through is foreground in BOTH (so excluded), and permanent
scenery is background in both (also excluded).

LEFT vs REMOVED is then decided by edge density inside the region compared with
the stored reference: an object appearing ADDS edges, an object taken away
REMOVES them. Without that check the two are indistinguishable, since both look
identical to a background subtractor.

Known limits, stated plainly:
  * No owner association. Real abandoned-baggage systems correlate the object
    with the person who left it; that needs the person module's tracks and is
    not wired here.
  * A parked vehicle or a chair moved into shot is, correctly, a "left" object.
    Zone masking is how you scope this to the area you care about.
"""
from __future__ import annotations

import cv2
import numpy as np


class Candidate:
    __slots__ = ("bbox", "first_seen", "last_seen", "alerted", "kind", "ref_edges")

    def __init__(self, bbox, now, kind, ref_edges):
        self.bbox = bbox
        self.first_seen = now
        self.last_seen = now
        self.alerted = False
        self.kind = kind
        self.ref_edges = ref_edges


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class ObjectDetector:
    def __init__(
        self,
        *,
        warmup_frames: int = 60,
        slow_lr: float = 0.0005,
        fast_lr: float = 0.02,
        min_area_frac: float = 0.0008,
        max_area_frac: float = 0.25,
        persist_seconds: float = 30.0,
        match_iou: float = 0.3,
        gone_seconds: float = 5.0,
        edge_delta: float = 0.25,
        cooldown_seconds: float = 300.0,
        proc_width: int = 480,
        zone_mask_spec: str = "",
    ):
        self.warmup_frames = warmup_frames
        self.slow_lr = slow_lr
        self.fast_lr = fast_lr
        self.min_area_frac = min_area_frac
        self.max_area_frac = max_area_frac
        self.persist_seconds = persist_seconds
        self.match_iou = match_iou
        self.gone_seconds = gone_seconds
        self.edge_delta = edge_delta
        self.cooldown_seconds = cooldown_seconds
        self.proc_width = proc_width

        # varThreshold high-ish and shadows off: shadows are the main source of
        # phantom "objects" in outdoor scenes.
        self.bg_slow = cv2.createBackgroundSubtractorMOG2(
            history=2000, varThreshold=32, detectShadows=False)
        self.bg_fast = cv2.createBackgroundSubtractorMOG2(
            history=100, varThreshold=32, detectShadows=False)

        self.ref_gray: np.ndarray | None = None
        self.zone_spec = zone_mask_spec
        self.zone_mask: np.ndarray | None = None
        self.frames = 0
        self.candidates: list[Candidate] = []
        self.last_alert = 0.0

    # ------------------------------------------------------------ helpers
    def _prep(self, frame):
        h, w = frame.shape[:2]
        if w > self.proc_width:
            s = self.proc_width / float(w)
            frame = cv2.resize(frame, (self.proc_width, int(h * s)))
        return frame, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    def _build_zone_mask(self, shape):
        h, w = shape
        if not self.zone_spec.strip():
            return np.full((h, w), 255, np.uint8)
        nums = [float(v) for v in self.zone_spec.replace(";", ",").split(",") if v.strip()]
        pts = np.array([[int(nums[i]), int(nums[i + 1])] for i in range(0, len(nums), 2)],
                       np.int32)
        mask = np.zeros((h, w), np.uint8)
        cv2.fillPoly(mask, [pts], 255)
        return mask

    @staticmethod
    def _edge_density(patch) -> float:
        if patch.size == 0:
            return 0.0
        return float(np.count_nonzero(cv2.Canny(patch, 50, 150))) / patch.size

    def _scale_to_source(self, bbox, small_shape, src_shape):
        sh, sw = small_shape
        H, W = src_shape
        fx, fy = W / float(sw), H / float(sh)
        x1, y1, x2, y2 = bbox
        return (int(x1 * fx), int(y1 * fy), int(x2 * fx), int(y2 * fy))

    # ------------------------------------------------------------- update
    def update(self, frame, now: float) -> list[dict]:
        small, gray = self._prep(frame)
        h, w = gray.shape
        self.frames += 1

        if self.zone_mask is None or self.zone_mask.shape != (h, w):
            self.zone_mask = self._build_zone_mask((h, w))

        fg_slow = self.bg_slow.apply(small, learningRate=self.slow_lr)
        fg_fast = self.bg_fast.apply(small, learningRate=self.fast_lr)

        if self.frames <= self.warmup_frames:
            # Learn the empty scene before judging anything, and keep a
            # reference frame so left/removed can be told apart later.
            self.ref_gray = gray.copy()
            return []

        # Arrived, then stopped moving.
        static = cv2.bitwise_and(fg_slow, cv2.bitwise_not(fg_fast))
        static = cv2.bitwise_and(static, self.zone_mask)

        # Clean up speckle; close gaps so one object is one blob.
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        static = cv2.morphologyEx(static, cv2.MORPH_OPEN, k, iterations=1)
        static = cv2.morphologyEx(static, cv2.MORPH_CLOSE, k, iterations=2)

        area_px = h * w
        contours, _ = cv2.findContours(static, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for c in contours:
            a = cv2.contourArea(c)
            if a < self.min_area_frac * area_px or a > self.max_area_frac * area_px:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            boxes.append((x, y, x + bw, y + bh))

        # Match to existing candidates so persistence accumulates per object.
        matched = set()
        for b in boxes:
            hit = None
            for i, cand in enumerate(self.candidates):
                if i in matched:
                    continue
                if _iou(b, cand.bbox) >= self.match_iou:
                    hit = i
                    break
            if hit is None:
                patch_ref = (self.ref_gray[b[1]:b[3], b[0]:b[2]]
                             if self.ref_gray is not None else np.empty((0, 0), np.uint8))
                self.candidates.append(
                    Candidate(b, now, None, self._edge_density(patch_ref)))
            else:
                matched.add(hit)
                self.candidates[hit].bbox = b
                self.candidates[hit].last_seen = now

        events = []
        for cand in self.candidates:
            if cand.alerted or now - cand.last_seen > 1.0:
                continue
            if now - cand.first_seen < self.persist_seconds:
                continue
            if now - self.last_alert < self.cooldown_seconds:
                continue

            x1, y1, x2, y2 = cand.bbox
            now_edges = self._edge_density(gray[y1:y2, x1:x2])
            # An object appearing ADDS edges; one taken away REMOVES them.
            # Without this the two cases are indistinguishable to a background
            # subtractor — both are simply "this region changed and stayed".
            if now_edges > cand.ref_edges * (1.0 + self.edge_delta):
                kind = "object_left"
            elif now_edges < cand.ref_edges * (1.0 - self.edge_delta):
                kind = "object_removed"
            else:
                # Changed but not clearly either way (e.g. a same-texture
                # swap). Reporting a guess here would be worse than silence.
                continue

            cand.alerted = True
            cand.kind = kind
            self.last_alert = now
            events.append({
                "type": kind,
                "bbox": list(self._scale_to_source(cand.bbox, (h, w), frame.shape[:2])),
                "staticSeconds": round(now - cand.first_seen, 1),
                "edgeDensityNow": round(now_edges, 5),
                "edgeDensityRef": round(cand.ref_edges, 5),
            })

        # Retire candidates that stopped being static — the object was picked up
        # again, or it was a transient artefact.
        keep = []
        for cand in self.candidates:
            if now - cand.last_seen > self.gone_seconds:
                if cand.alerted:
                    events.append({
                        "type": f"{cand.kind}_cleared",
                        "bbox": list(self._scale_to_source(cand.bbox, (h, w), frame.shape[:2])),
                    })
                continue
            keep.append(cand)
        self.candidates = keep

        return events

    def status(self) -> dict:
        return {
            "frames": self.frames,
            "warmedUp": self.frames > self.warmup_frames,
            "candidates": len(self.candidates),
            "alerted": sum(1 for c in self.candidates if c.alerted),
        }
