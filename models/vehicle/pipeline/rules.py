"""Vehicle analytics beyond counting — all rules, no new model.

Every feature here runs on the detections and tracks the vehicle worker already
produces, so the marginal cost of a new feature is a rules class, not a training
run:

    wrong_way        crossing the counting line against the permitted direction
    illegal_parking  a vehicle stationary in a no-parking zone
    congestion       too many vehicles in a zone, or moving too slowly
    triple_riding    3+ people on one two-wheeler (India-specific enforcement)

Only rules named in ENABLED_FEATURES are constructed, so an unlicensed feature
costs nothing at runtime.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque


def _centre(bbox):
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def _parse_polygon(spec: str):
    if not spec or not spec.strip():
        return []
    nums = [float(v) for v in spec.replace(";", ",").split(",") if v.strip() != ""]
    if len(nums) < 6 or len(nums) % 2:
        raise ValueError(f"polygon needs an even count of >=6 numbers, got {len(nums)}")
    return [(nums[i], nums[i + 1]) for i in range(0, len(nums), 2)]


def _in_polygon(pt, poly) -> bool:
    """Empty polygon = whole frame, so an unconfigured rule watches everything
    rather than silently never firing."""
    if not poly:
        return True
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1
            if x < xin:
                inside = not inside
    return inside


class VehicleRule:
    feature: str = ""

    def __init__(self, cfg):
        self.cfg = cfg

    def update(self, dets, crossings, frame_no: int, now: float) -> list[dict]:
        """`crossings` is {track_id: direction} for tracks that crossed the
        counting line this frame — computed once by the worker so several rules
        can share it."""
        return []

    def forget(self, keep: set, frame_no: int) -> None:
        pass


# --------------------------------------------------------------- wrong way
class WrongWayRule(VehicleRule):
    """A vehicle crossed the counting line against the permitted direction.

    Reuses the crossing the counting line already computes — direction was
    always in the event, this simply gives it a meaning.
    """

    feature = "wrong_way"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.allowed = (cfg.WRONG_WAY_ALLOWED or "in").strip().lower()
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.alerted: dict[int, float] = {}

    def update(self, dets, crossings, frame_no, now):
        out = []
        by_id = {d.track_id: d for d in dets}
        for tid, direction in crossings.items():
            if direction == self.allowed:
                continue
            if now - self.alerted.get(tid, 0) < self.cooldown:
                continue
            self.alerted[tid] = now
            d = by_id.get(tid)
            out.append({
                "type": "wrong_way",
                "trackId": tid,
                "direction": direction,
                "allowedDirection": self.allowed,
                "vehicleType": getattr(d, "cls_name", None),
                "bbox": list(d.bbox) if d else None,
            })
        return out

    def forget(self, keep, frame_no):
        for tid in list(self.alerted):
            if tid not in keep:
                self.alerted.pop(tid, None)


# --------------------------------------------------------- illegal parking
class IllegalParkingRule(VehicleRule):
    """A vehicle stationary inside a no-parking zone for too long.

    "Stationary" is measured as centroid movement relative to the vehicle's OWN
    box size, not in absolute pixels: a vehicle far from the camera moves fewer
    pixels for the same real distance, so a fixed pixel threshold would call
    every distant moving vehicle parked.
    """

    feature = "illegal_parking"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.zone = _parse_polygon(cfg.PARKING_ZONE)
        self.seconds = cfg.PARKING_SECONDS
        self.move_frac = cfg.PARKING_MOVE_FRACTION
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.anchor: dict[int, tuple] = {}     # track -> (x, y, t_since)
        self.alerted: dict[int, float] = {}

    def update(self, dets, crossings, frame_no, now):
        out = []
        for d in dets:
            if d.track_id < 0:
                continue
            cx, cy = _centre(d.bbox)
            if not _in_polygon((cx, cy), self.zone):
                self.anchor.pop(d.track_id, None)
                continue

            x1, y1, x2, y2 = d.bbox
            size = max(1.0, ((x2 - x1) * (y2 - y1)) ** 0.5)
            tol = self.move_frac * size

            ax, ay, since = self.anchor.get(d.track_id, (cx, cy, now))
            if abs(cx - ax) > tol or abs(cy - ay) > tol:
                # Moved: reset the anchor and the clock.
                self.anchor[d.track_id] = (cx, cy, now)
                continue
            self.anchor[d.track_id] = (ax, ay, since)

            if now - since < self.seconds:
                continue
            if now - self.alerted.get(d.track_id, 0) < self.cooldown:
                continue
            self.alerted[d.track_id] = now
            out.append({
                "type": "illegal_parking",
                "trackId": d.track_id,
                "vehicleType": d.cls_name,
                "stationarySeconds": round(now - since, 1),
                "bbox": list(d.bbox),
            })
        return out

    def forget(self, keep, frame_no):
        for dct in (self.anchor, self.alerted):
            for tid in list(dct):
                if tid not in keep:
                    dct.pop(tid, None)


# --------------------------------------------------------------- congestion
class CongestionRule(VehicleRule):
    """Too many vehicles in a zone, sustained.

    Uses a rolling median rather than the instantaneous count: detection drops a
    vehicle for a frame constantly, and a raw count would flap across the
    threshold and emit a burst of alerts. Same reasoning as crowd density.
    """

    feature = "congestion"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.zone = _parse_polygon(cfg.CONGESTION_ZONE)
        self.limit = cfg.CONGESTION_LIMIT
        self.window = deque(maxlen=max(1, cfg.CONGESTION_WINDOW_FRAMES))
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.last_alert = 0.0
        self.active = False

    def update(self, dets, crossings, frame_no, now):
        n = sum(1 for d in dets if _in_polygon(_centre(d.bbox), self.zone))
        self.window.append(n)
        s = sorted(self.window)
        median = s[len(s) // 2]

        if median >= self.limit:
            if now - self.last_alert < self.cooldown:
                return []
            self.last_alert = now
            self.active = True
            return [{
                "type": "congestion",
                "count": median,
                "limit": self.limit,
                "instantaneous": n,
            }]

        if self.active and median < self.limit * 0.7:
            # Hysteresis: clearing at the same threshold it triggered on would
            # oscillate around the boundary.
            self.active = False
            return [{"type": "congestion_cleared", "count": median}]
        return []


# ------------------------------------------------------------ triple riding
class TripleRidingRule(VehicleRule):
    """3+ people on one two-wheeler.

    Needs person boxes, which this worker does not produce — the vehicle model
    has no `person` class. Rather than pretend, the rule counts people only if
    the caller supplies them (see VehicleWorker: it passes person boxes when the
    person module is co-resident on the same camera). Without them it stays
    silent instead of guessing from the two-wheeler box alone, which cannot
    distinguish two riders from three.
    """

    feature = "triple_riding"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.min_people = cfg.TRIPLE_RIDING_PEOPLE
        self.min_overlap = cfg.TRIPLE_RIDING_OVERLAP
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.hist: dict[int, deque] = defaultdict(lambda: deque(maxlen=10))
        self.alerted: dict[int, float] = {}
        self.warned = False

    @staticmethod
    def _overlap_frac(person, vehicle) -> float:
        """Fraction of the PERSON box inside the vehicle box — riders sit
        within the two-wheeler's footprint even though their heads rise above."""
        px1, py1, px2, py2 = person
        vx1, vy1, vx2, vy2 = vehicle
        ix1, iy1 = max(px1, vx1), max(py1, vy1)
        ix2, iy2 = min(px2, vx2), min(py2, vy2)
        iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
        inter = iw * ih
        parea = max(1, (px2 - px1) * (py2 - py1))
        return inter / parea

    def update(self, dets, crossings, frame_no, now, person_boxes=None):
        if not person_boxes:
            if not self.warned:
                self.warned = True
                print("[rules] triple_riding needs person boxes; none supplied — "
                      "enable the person module on this camera. Staying silent.")
            return []

        out = []
        for d in dets:
            if d.cls_name != "two_wheeler" or d.track_id < 0:
                continue
            riders = sum(1 for p in person_boxes
                         if self._overlap_frac(p, d.bbox) >= self.min_overlap)
            self.hist[d.track_id].append(riders)

            h = self.hist[d.track_id]
            if len(h) < 3:
                continue
            # Median over recent frames: a person walking past behind a bike
            # briefly overlaps it, and a single frame must not book someone.
            med = sorted(h)[len(h) // 2]
            if med < self.min_people:
                continue
            if now - self.alerted.get(d.track_id, 0) < self.cooldown:
                continue
            self.alerted[d.track_id] = now
            out.append({
                "type": "triple_riding",
                "trackId": d.track_id,
                "riders": med,
                "bbox": list(d.bbox),
            })
        return out

    def forget(self, keep, frame_no):
        for dct in (self.hist, self.alerted):
            for tid in list(dct):
                if tid not in keep:
                    dct.pop(tid, None)


VEHICLE_RULES: dict[str, type[VehicleRule]] = {
    r.feature: r
    for r in (WrongWayRule, IllegalParkingRule, CongestionRule, TripleRidingRule)
}


def build_vehicle_rules(features, cfg) -> list[VehicleRule]:
    """Instantiate ONLY the licensed features. `vehicle_count` is handled by the
    worker itself, not as a rule, so it is skipped here rather than warned about."""
    out = []
    for f in features:
        f = f.strip()
        if not f or f == "vehicle_count":
            continue
        cls = VEHICLE_RULES.get(f)
        if cls is None:
            print(f"[rules] unknown vehicle feature '{f}' — skipping")
            continue
        out.append(cls(cfg))
    return out
