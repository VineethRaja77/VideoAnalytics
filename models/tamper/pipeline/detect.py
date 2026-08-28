"""Camera tamper detection — no AI model, just image statistics.

Detects the four ways a camera stops being useful:
    blocked   — lens covered, sprayed, or something parked in front of it
    defocused — lens turned or knocked out of focus
    moved     — camera physically re-aimed
    signal    — frozen/black frames (feed alive but carrying nothing)

WHY RELATIVE, NOT ABSOLUTE, THRESHOLDS
    A blur or edge-density number that means "tampered" on one camera means
    "normal" on another — a foggy car park and a lit corridor differ by an order
    of magnitude. So each metric is compared against a BASELINE this camera
    learned from its own recent history, and the alert is a proportional drop.
    That is what lets one config work across a whole site.

WHY A HOLD TIME
    A truck passing close to the lens looks exactly like blocking for a second.
    Every detector here must see the condition persist for HOLD_SECONDS before
    it alerts, which is the single biggest false-positive killer.

The baseline adapts slowly, so gradual change (dusk, weather) is absorbed while
a sudden persistent change still fires.
"""
from __future__ import annotations

from collections import deque

import cv2
import numpy as np


class TamperDetector:
    def __init__(
        self,
        *,
        warmup_frames: int = 30,
        baseline_frames: int = 300,
        blur_drop: float = 0.45,
        edge_drop: float = 0.40,
        scene_change: float = 0.45,
        dark_level: float = 12.0,
        frozen_delta: float = 0.15,
        hold_seconds: float = 5.0,
        cooldown_seconds: float = 300.0,
        proc_width: int = 320,
    ):
        self.warmup_frames = warmup_frames
        self.blur_drop = blur_drop
        self.edge_drop = edge_drop
        self.scene_change = scene_change
        self.dark_level = dark_level
        self.frozen_delta = frozen_delta
        self.hold_seconds = hold_seconds
        self.cooldown_seconds = cooldown_seconds
        self.proc_width = proc_width

        # Rolling baselines of this camera's own normal behaviour.
        self.blur_hist: deque = deque(maxlen=baseline_frames)
        self.edge_hist: deque = deque(maxlen=baseline_frames)

        self.ref_sig: np.ndarray | None = None   # reference structural signature
        self.prev_gray: np.ndarray | None = None
        self.frames = 0

        # condition -> time it was first seen continuously
        self.since: dict[str, float] = {}
        self.last_alert: dict[str, float] = {}
        self.active: set[str] = set()

    # ------------------------------------------------------------ metrics
    def _prep(self, frame):
        h, w = frame.shape[:2]
        if w > self.proc_width:
            scale = self.proc_width / float(w)
            frame = cv2.resize(frame, (self.proc_width, int(h * scale)))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        return frame, gray

    @staticmethod
    def _blur_score(gray) -> float:
        """Variance of the Laplacian — low means few sharp edges, i.e. blurred."""
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    @staticmethod
    def _edge_density(gray) -> float:
        """Fraction of pixels on an edge. Collapses when the lens is covered."""
        edges = cv2.Canny(gray, 50, 150)
        return float(np.count_nonzero(edges)) / edges.size

    @staticmethod
    def _signature(gray) -> np.ndarray:
        """Structural signature of the scene: a contrast-normalised thumbnail.

        Deliberately NOT a colour histogram. An HS histogram sounds
        brightness-invariant but is not: auto-exposure and gain changes shift
        SATURATION, so a cloud passing over reads as the camera having moved.

        Normalising a small greyscale thumbnail to zero mean and unit variance
        makes the comparison exactly invariant to any linear brightness/contrast
        change (alpha*x + beta) — which is precisely what a camera's AGC does —
        while still changing completely if the camera is re-aimed.
        """
        t = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
        t -= t.mean()
        s = t.std()
        return t / s if s > 1e-6 else t

    @staticmethod
    def _similarity(a: np.ndarray, b: np.ndarray) -> float:
        """Normalised cross-correlation in [-1, 1]; 1.0 = identical structure."""
        n = a.size
        if n == 0:
            return 1.0
        return float(np.clip((a * b).sum() / n, -1.0, 1.0))

    @staticmethod
    def _median(d: deque) -> float:
        s = sorted(d)
        return s[len(s) // 2] if s else 0.0

    # ------------------------------------------------------------- update
    def update(self, frame, now: float) -> list[dict]:
        """Feed one frame. Returns newly-confirmed tamper events."""
        small, gray = self._prep(frame)
        self.frames += 1

        blur = self._blur_score(gray)
        edge = self._edge_density(gray)
        sig = self._signature(gray)
        mean_level = float(gray.mean())

        # Frame-to-frame difference, for the frozen-feed check.
        delta = None
        if self.prev_gray is not None and self.prev_gray.shape == gray.shape:
            delta = float(np.abs(gray.astype(np.int16) - self.prev_gray.astype(np.int16)).mean())
        self.prev_gray = gray

        # ---- warm-up: learn what normal looks like before judging anything ----
        if self.frames <= self.warmup_frames:
            self.blur_hist.append(blur)
            self.edge_hist.append(edge)
            if self.ref_sig is None:
                self.ref_sig = sig
            return []

        base_blur = self._median(self.blur_hist) or 1e-6
        base_edge = self._median(self.edge_hist) or 1e-6

        scene_sim = 1.0
        if self.ref_sig is not None:
            # 1.0 = identical structure, 0.0 = unrelated view
            scene_sim = self._similarity(self.ref_sig, sig)

        conditions: dict[str, dict] = {}

        # Blacked out / lens capped: almost no light at all.
        if mean_level < self.dark_level:
            conditions["blocked"] = {"reason": "dark", "meanLevel": round(mean_level, 1)}
        # Covered: edges collapse relative to this camera's own norm.
        elif edge < base_edge * (1.0 - self.edge_drop):
            conditions["blocked"] = {
                "reason": "edges_lost",
                "edgeDensity": round(edge, 5),
                "baseline": round(base_edge, 5),
            }

        # Defocused: sharpness collapses but the scene is still visible.
        if "blocked" not in conditions and blur < base_blur * (1.0 - self.blur_drop):
            conditions["defocused"] = {
                "blurScore": round(blur, 1),
                "baseline": round(base_blur, 1),
            }

        # Moved: the colour signature diverges from the reference while the
        # image itself is still sharp and detailed (otherwise it is blocking).
        if "blocked" not in conditions and scene_sim < (1.0 - self.scene_change):
            conditions["moved"] = {"sceneSimilarity": round(scene_sim, 3)}

        # Frozen feed: consecutive frames essentially identical. A real scene
        # always has some noise, so a near-zero delta means the decoder is
        # repeating a frame.
        if delta is not None and delta < self.frozen_delta:
            conditions["signal"] = {"reason": "frozen", "frameDelta": round(delta, 3)}

        events = []
        for name, detail in conditions.items():
            first = self.since.setdefault(name, now)
            if now - first < self.hold_seconds:
                continue                      # not sustained yet
            if now - self.last_alert.get(name, 0.0) < self.cooldown_seconds:
                continue
            self.last_alert[name] = now
            self.active.add(name)
            events.append({
                "type": f"camera_tamper",
                "condition": name,
                "heldSeconds": round(now - first, 1),
                **detail,
            })

        # Clear conditions that stopped, and emit a recovery so an operator
        # knows the camera came back without having to watch it.
        for name in list(self.since):
            if name not in conditions:
                self.since.pop(name, None)
                if name in self.active:
                    self.active.discard(name)
                    events.append({
                        "type": "camera_tamper_cleared",
                        "condition": name,
                    })

        # Only learn from frames that look untampered, otherwise the baseline
        # drifts toward the tampered state and the alert silently self-clears.
        if not conditions:
            self.blur_hist.append(blur)
            self.edge_hist.append(edge)
            if self.ref_sig is not None:
                # Slow EMA: absorbs dusk and weather, not a sudden re-aim.
                self.ref_sig = 0.99 * self.ref_sig + 0.01 * sig

        return events

    def status(self) -> dict:
        return {
            "frames": self.frames,
            "warmedUp": self.frames > self.warmup_frames,
            "active": sorted(self.active),
            "baselineBlur": round(self._median(self.blur_hist), 1),
            "baselineEdge": round(self._median(self.edge_hist), 5),
        }
