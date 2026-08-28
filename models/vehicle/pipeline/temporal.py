"""Stage 2: per-track class voting.

Detection is per-frame. CLASSIFICATION MUST BE PER-TRACK.

A YOLO detector re-decides the class of every box from scratch on every frame,
with no memory. At 10 fps the same car is classified 10 times a second, and a
handful of those frames will land on van/lcv/truck — that is the flicker you see
in raw output. It is not a model defect; it is the absence of temporal state.

The fix: accumulate confidence-weighted votes per track id, report the running
argmax, and FREEZE the class once enough confident observations agree. After the
lock, one bad frame can no longer change a vehicle's identity.
"""
from collections import defaultdict, deque


#: Vote share the winner must hold before a class is frozen.
#: 0.6 was too permissive: at lock_frames=5 a 3-vs-2 split reaches exactly 0.6
#: and locked, which is noise rather than agreement — precisely the ambiguous
#: van/lcv case that should keep voting. 0.75 needs a genuine majority (4:1 at
#: five frames, 9:3 at twelve).
LOCK_SHARE = 0.75


class TrackClassVoter:
    def __init__(self, window: int, min_frames: int, lock_frames: int,
                 lock_share: float = LOCK_SHARE):
        self.window = window
        self.min_frames = min_frames
        self.lock_frames = lock_frames
        self.lock_share = lock_share
        # track_id -> deque of (class_name, confidence)
        self.history = defaultdict(lambda: deque(maxlen=window))
        # track_id -> locked class name (purged when the track leaves)
        self.locked = {}
        self.first_seen = {}
        self.last_seen = {}
        # Cumulative stats survive forget_absent, so diagnostics report what
        # happened over the whole run rather than whatever is still on screen.
        self.total_tracks = 0
        self.total_locked = 0

    def update(self, track_id: int, cls_name: str, conf: float, frame_no: int) -> None:
        if track_id < 0:
            return
        if track_id not in self.history:
            self.total_tracks += 1
        self.history[track_id].append((cls_name, conf))
        self.first_seen.setdefault(track_id, frame_no)
        self.last_seen[track_id] = frame_no

        if track_id in self.locked:
            return
        hist = self.history[track_id]
        if len(hist) < self.lock_frames:
            return
        winner, share = self._tally(hist)
        # Lock only on a clear majority. A track that keeps flip-flopping
        # (e.g. a genuinely ambiguous van/lcv) stays unlocked and keeps voting
        # rather than freezing an arbitrary early guess.
        if share >= self.lock_share:
            self.locked[track_id] = winner
            self.total_locked += 1

    @staticmethod
    def _tally(hist) -> tuple[str, float]:
        """Confidence-weighted vote. Returns (class, winner's vote share)."""
        score = defaultdict(float)
        for name, conf in hist:
            score[name] += conf
        total = sum(score.values()) or 1.0
        winner = max(score, key=score.get)
        return winner, score[winner] / total

    def klass(self, track_id: int) -> tuple[str | None, bool]:
        """Return (class_name, is_locked). None until min_frames observations."""
        if track_id in self.locked:
            return self.locked[track_id], True
        hist = self.history.get(track_id)
        if not hist or len(hist) < self.min_frames:
            return None, False
        winner, _ = self._tally(hist)
        return winner, False

    def stability(self, track_id: int) -> float:
        """Vote share of the current winner — a confidence in the class itself."""
        hist = self.history.get(track_id)
        if not hist:
            return 0.0
        return self._tally(hist)[1]

    def forget_absent(self, active_ids: set, frame_no: int, grace: int = 30) -> None:
        """Drop state for tracks gone for more than `grace` frames.

        The grace period is essential, not just hygiene. ByteTrack keeps a track
        id alive across short occlusions (a vehicle behind a pole, one missed
        detection), so a track absent from THIS frame is usually still the same
        vehicle and will reappear with the same id. Purging on first absence
        resets its vote to zero every time — which both destroys the class lock
        and inflates the track count. Match this to the tracker's own buffer.

        Track ids remain a within-session handle only: they are re-issued after a
        track is truly lost and reset on restart. Nothing here is persisted; the
        durable key for an event is (cameraId, timestamp, uuid).
        """
        for tid in list(self.history.keys()):
            if tid in active_ids:
                continue
            if frame_no - self.last_seen.get(tid, frame_no) <= grace:
                continue  # still within the occlusion grace window
            self.history.pop(tid, None)
            self.locked.pop(tid, None)
            self.first_seen.pop(tid, None)
            self.last_seen.pop(tid, None)
