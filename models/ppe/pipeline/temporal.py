"""Stage 8+9: temporal verification + compliance decision.

Per worker (track ID) we keep a rolling window of per-frame PPE assessments.
A violation is only confirmed when we've observed the item enough times AND it
was "missing" in a strong majority of those frames — this kills single-frame
flicker and low-confidence noise. Confirmed violations are rate-limited per
(track, item) by a cooldown so one worker doesn't spam alerts.
"""
import time
from collections import defaultdict, deque


class ComplianceTracker:
    def __init__(self, window: int, min_frames: int, violation_ratio: float, cooldown_s: float):
        self.window = window
        self.min_frames = min_frames
        self.violation_ratio = violation_ratio
        self.cooldown_s = cooldown_s
        # track_id -> item -> deque of "present"/"missing"/"unknown"
        self.history = defaultdict(lambda: defaultdict(lambda: deque(maxlen=window)))
        # (track_id, item) -> last_alert_ts
        self.last_alert = {}

    def update(self, track_id: int, assessment: dict) -> list[dict]:
        """Feed one frame's assessment for a track; return newly-confirmed violations."""
        confirmed = []
        now = time.time()
        for item, state in assessment.items():
            hist = self.history[track_id][item]
            hist.append(state)

            observed = [s for s in hist if s in ("present", "missing")]
            if len(observed) < self.min_frames:
                continue
            missing = observed.count("missing")
            ratio = missing / len(observed)
            if ratio < self.violation_ratio:
                continue

            key = (track_id, item)
            if now - self.last_alert.get(key, 0) < self.cooldown_s:
                continue
            self.last_alert[key] = now
            confirmed.append({
                "trackId": track_id,
                "item": item,
                "missingRatio": round(ratio, 2),
                "framesObserved": len(observed),
            })
        return confirmed

    def snapshot_state(self, track_id: int) -> dict:
        """Current per-item majority state for reporting (present/missing/unknown)."""
        out = {}
        for item, hist in self.history.get(track_id, {}).items():
            observed = [s for s in hist if s in ("present", "missing")]
            if not observed:
                out[item] = "unknown"
            else:
                out[item] = "missing" if observed.count("missing") / len(observed) >= self.violation_ratio else "present"
        return out

    def forget_absent(self, active_ids: set) -> None:
        """Drop state for tracks no longer on screen (memory hygiene)."""
        for tid in list(self.history.keys()):
            if tid not in active_ids:
                del self.history[tid]
