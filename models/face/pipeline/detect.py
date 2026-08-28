"""Stage 1: face detection + alignment.

Detector is YuNet (OpenCV Zoo, MIT licence — commercially usable, ~230 KB).

Alignment is not optional. ArcFace-family embedders are trained on faces warped
to a fixed 112x112 canonical layout via 5 landmarks; feeding a raw crop instead
degrades similarity badly, and the damage is worst on exactly the off-angle faces
CCTV produces. YuNet returns the 5 points we need, so alignment is nearly free.
"""
import cv2
import numpy as np

# Canonical ArcFace 5-point reference for a 112x112 crop, in
# (right_eye, left_eye, nose, right_mouth, left_mouth) order — "right" meaning
# the subject's right, which appears on the left of the image. YuNet emits its
# landmarks in this same order, so the mapping is 1:1.
ARCFACE_REF = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)


class Face:
    __slots__ = ("bbox", "score", "landmarks", "aligned")

    def __init__(self, bbox, score, landmarks, aligned):
        self.bbox = bbox            # (x1,y1,x2,y2) ints
        self.score = score          # detector confidence
        self.landmarks = landmarks  # (5,2) float32
        self.aligned = aligned      # 112x112x3 BGR, ready for the embedder

    @property
    def eye_distance(self) -> float:
        """Interocular distance in pixels — the single best predictor of whether
        recognition will work at all. Industry guidance: >=40 px usable,
        >=80 px reliable, <20 px detection-only."""
        return float(np.linalg.norm(self.landmarks[0] - self.landmarks[1]))

    @property
    def centroid(self) -> tuple:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)


class FaceDetector:
    def __init__(self, model_path, conf=0.7, nms=0.3, top_k=5000):
        self.model_path = model_path
        self.conf = conf
        self._det = cv2.FaceDetectorYN.create(model_path, "", (320, 320),
                                              conf, nms, top_k)
        self._size = (320, 320)

    def _ensure_size(self, w, h):
        if self._size != (w, h):
            self._det.setInputSize((w, h))
            self._size = (w, h)

    @staticmethod
    def align(frame, landmarks) -> np.ndarray:
        """Similarity-warp the face to the canonical 112x112 ArcFace layout."""
        M, _ = cv2.estimateAffinePartial2D(landmarks, ARCFACE_REF,
                                           method=cv2.LMEDS)
        if M is None:
            return None
        return cv2.warpAffine(frame, M, (112, 112), borderValue=0)

    def detect(self, frame) -> list[Face]:
        h, w = frame.shape[:2]
        self._ensure_size(w, h)
        _, faces = self._det.detect(frame)
        out = []
        if faces is None:
            return out
        for f in faces:
            x, y, fw, fh = f[0:4]
            lms = np.array(f[4:14], dtype=np.float32).reshape(5, 2)
            aligned = self.align(frame, lms)
            if aligned is None:
                continue
            bbox = (int(x), int(y), int(x + fw), int(y + fh))
            out.append(Face(bbox, float(f[14]), lms, aligned))
        return out
