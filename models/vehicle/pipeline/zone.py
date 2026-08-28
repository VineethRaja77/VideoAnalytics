"""Stage 3: counting line.

Count CROSSINGS, not presence. Counting "vehicles visible in the frame" makes a
parked car contribute once per frame — 600 counts for one stationary vehicle.
A crossing fires exactly once per track id, when that track's centroid moves
from one side of the line to the other, and records the direction.

This also bounds the duplicate-identity problem: a track only has to hold its id
for the instant it crosses, not for its whole trajectory.
"""


class CountingLine:
    def __init__(self, spec: str, counted_ttl_frames: int = 3000):
        self.enabled = bool(spec.strip())
        self.counted = {}       # track_id -> (direction, frame_no)
        self.prev_side = {}     # track_id -> last observed side
        # A 24/7 worker issues track ids indefinitely, so `counted` cannot be
        # kept forever — it would grow without bound. Entries expire after a TTL
        # far longer than any plausible dwell time near the line, which keeps the
        # double-count guard effective while bounding memory.
        self.counted_ttl_frames = counted_ttl_frames
        if self.enabled:
            x1, y1, x2, y2 = (float(v) for v in spec.split(","))
            self.p1 = (x1, y1)
            self.p2 = (x2, y2)

    def _side(self, px, py) -> float:
        (x1, y1), (x2, y2) = self.p1, self.p2
        return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)

    def check(self, track_id: int, centroid, frame_no: int = 0) -> str | None:
        """Feed a track's centroid. Returns 'in'/'out' on the crossing frame,
        else None. Fires at most once per track id."""
        if not self.enabled or track_id < 0:
            return None
        if track_id in self.counted:
            return None

        s = self._side(*centroid)
        prev = self.prev_side.get(track_id)
        self.prev_side[track_id] = s

        if prev is None or s == 0:
            return None
        if (prev > 0) == (s > 0):
            return None  # same side, no crossing

        direction = "in" if s > 0 else "out"
        self.counted[track_id] = (direction, frame_no)
        return direction

    def forget_absent(self, active_ids: set, seen_recently: set | None = None,
                      frame_no: int = 0) -> None:
        """Drop side-state for tracks that are truly gone, and expire old
        counted-entries so memory stays bounded on a long-running worker.

        Same reasoning as the voter: a track missing from one frame is usually
        occluded, not gone. Dropping prev_side too eagerly loses the "which side
        was it on" memory, so the next detection looks like a fresh track and the
        crossing is never registered. `seen_recently` is the voter's still-tracked
        set, which already applies the occlusion grace window.
        """
        keep = active_ids if seen_recently is None else (active_ids | seen_recently)
        for tid in list(self.prev_side.keys()):
            if tid not in keep:
                self.prev_side.pop(tid, None)

        if frame_no and frame_no % 500 == 0:      # sweep occasionally, not per frame
            cutoff = frame_no - self.counted_ttl_frames
            for tid, (_, seen) in list(self.counted.items()):
                if seen < cutoff and tid not in keep:
                    self.counted.pop(tid, None)
        # `counted` is intentionally NOT purged on track loss: if a vehicle's id
        # survives but it lingers near the line, we must not count it twice.
        # It is bounded by the session and cleared on restart.
