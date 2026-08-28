"""Lightweight IoU tracker for faces.

YuNet has no built-in tracking (unlike the YOLO models used elsewhere), and the
identity voter needs a stable per-person handle across frames. Greedy IoU
association is sufficient for a gate/entrance camera where people move
predictably and faces are reasonably large.

It has no appearance model, so it will swap ids if two people cross directly over
each other. If that matters for your deployment, upgrade to an appearance-based
tracker; the rest of the pipeline is unchanged because it only consumes track ids.

Track ids are a WITHIN-SESSION handle: reused after a track is lost, reset on
restart. Never persist one as a key.
"""


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


class IouTracker:
    def __init__(self, iou_threshold=0.3, grace_frames=20):
        self.iou_threshold = iou_threshold
        self.grace_frames = grace_frames
        self.tracks = {}        # id -> bbox
        self.last_seen = {}     # id -> frame_no
        self._next_id = 1

    def update(self, boxes, frame_no: int) -> list[int]:
        """Assign a track id to each detection box, in input order."""
        assigned = [-1] * len(boxes)
        used = set()

        # Greedy best-IoU matching, strongest pairs first.
        pairs = []
        for di, box in enumerate(boxes):
            for tid, tbox in self.tracks.items():
                v = _iou(box, tbox)
                if v >= self.iou_threshold:
                    pairs.append((v, di, tid))
        pairs.sort(reverse=True)

        for _, di, tid in pairs:
            if assigned[di] != -1 or tid in used:
                continue
            assigned[di] = tid
            used.add(tid)

        for di, box in enumerate(boxes):
            if assigned[di] == -1:
                assigned[di] = self._next_id
                self._next_id += 1
            self.tracks[assigned[di]] = box
            self.last_seen[assigned[di]] = frame_no

        # Retire tracks unseen for longer than the grace window. As with the
        # vehicle module, dropping on first absence would restart identity votes
        # every time somebody turns their head.
        for tid in list(self.tracks.keys()):
            if frame_no - self.last_seen.get(tid, frame_no) > self.grace_frames:
                self.tracks.pop(tid, None)
                self.last_seen.pop(tid, None)

        return assigned

    @property
    def active_ids(self) -> set:
        return set(self.tracks.keys())
