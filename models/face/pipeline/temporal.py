"""Stage 4: per-track identity voting.

Same principle as the vehicle module, and for the same reason: a single frame
must never decide an identity. A face at an unlucky angle, half-blinked or
motion-blurred can score badly for one frame; accepting that frame's answer is
how you get a person's name flickering, or worse, a wrong name logged.

Votes are similarity-weighted and accumulated per track. "unknown" votes count
too — a person who is genuinely not enrolled should converge on unknown, not be
eventually captured by whichever enrolled face they drifted closest to once.
"""
from collections import defaultdict, deque

from .gallery import UNKNOWN


class IdentityVoter:
    #: See the vehicle module: 0.6 lets a bare 3-vs-2 split freeze an identity.
    #: Naming a person from a near-tie is worse than staying undecided.

    def __init__(self, window: int, min_frames: int, lock_frames: int,
                 lock_share: float = 0.75):
        self.window = window
        self.min_frames = min_frames
        self.lock_frames = lock_frames
        self.lock_share = lock_share
        self.history = defaultdict(lambda: deque(maxlen=window))
        self.locked = {}
        self.last_seen = {}
        self.total_tracks = 0
        self.total_locked = 0

    def update(self, track_id: int, name: str, sim: float, frame_no: int) -> None:
        if track_id < 0:
            return
        if track_id not in self.history:
            self.total_tracks += 1
        # An unknown carries a fixed small weight rather than its (low, noisy)
        # similarity, so it competes fairly without being drowned out.
        self.history[track_id].append((name, 0.25 if name == UNKNOWN else sim))
        self.last_seen[track_id] = frame_no

        if track_id in self.locked:
            return
        hist = self.history[track_id]
        if len(hist) < self.lock_frames:
            return
        winner, share = self._tally(hist)
        if share >= self.lock_share:
            self.locked[track_id] = winner
            self.total_locked += 1

    @staticmethod
    def _tally(hist) -> tuple[str, float]:
        score = defaultdict(float)
        for name, w in hist:
            score[name] += w
        total = sum(score.values()) or 1.0
        winner = max(score, key=score.get)
        return winner, score[winner] / total

    def identity(self, track_id: int) -> tuple[str | None, bool]:
        """(name, is_locked). None until min_frames observations exist."""
        if track_id in self.locked:
            return self.locked[track_id], True
        hist = self.history.get(track_id)
        if not hist or len(hist) < self.min_frames:
            return None, False
        return self._tally(hist)[0], False

    def confidence(self, track_id: int) -> float:
        hist = self.history.get(track_id)
        return self._tally(hist)[1] if hist else 0.0

    def forget_absent(self, active_ids: set, frame_no: int, grace: int = 30) -> None:
        """Purge only after `grace` frames of absence — a face missing from one
        frame (turned away, briefly occluded) is the same person, and resetting
        its vote would discard everything learned about them."""
        for tid in list(self.history.keys()):
            if tid in active_ids:
                continue
            if frame_no - self.last_seen.get(tid, frame_no) <= grace:
                continue
            self.history.pop(tid, None)
            self.locked.pop(tid, None)
            self.last_seen.pop(tid, None)
