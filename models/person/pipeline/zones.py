"""Geometry shared by every person rule: polygon zones and counting lines.

Kept separate from the rules so seven features do not each reimplement
"is this person inside the area" slightly differently.

Coordinate convention: a person's position is the BOTTOM-CENTRE of their box —
their feet — not the centroid. On an overhead-ish camera the centroid of a tall
box sits well above where the person is actually standing, so centroid-based
zone tests fire early on approach and late on exit.
"""
from __future__ import annotations


def feet(bbox) -> tuple[float, float]:
    """Ground contact point of a person box."""
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, float(y2))


def centroid(bbox) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


#: Separates SEVERAL areas in one setting.
#:
#: A yard camera covers the fuel store and the transformer bay, and they are not
#: one shape. ";" used to be an alias for "," (so "1,2;3,4" was a single
#: polygon); it now separates polygons, which is the only reading under which a
#: camera can carry more than one restricted area. Matches AREA_SEPARATOR in
#: shared/analyticsConfig.ts.
AREA_SEPARATOR = ";"


def parse_polygon(spec: str) -> list[tuple[float, float]]:
    """"x1,y1,x2,y2,x3,y3,..." -> [(x1,y1), ...]. Empty -> []."""
    if not spec or not spec.strip():
        return []
    nums = [float(v) for v in spec.split(",") if v.strip() != ""]
    if len(nums) < 6 or len(nums) % 2:
        raise ValueError(
            f"polygon needs an even count of at least 6 numbers, got {len(nums)}"
        )
    return [(nums[i], nums[i + 1]) for i in range(0, len(nums), 2)]


def parse_polygons(spec: str) -> list[list[tuple[float, float]]]:
    """One setting -> every area in it. Empty -> []."""
    if not spec or not spec.strip():
        return []
    return [
        parse_polygon(part)
        for part in spec.split(AREA_SEPARATOR)
        if part.strip() != ""
    ]


def point_in_any(pt, polys) -> bool:
    """Inside ANY of these areas.

    An empty LIST means no areas are defined; the caller decides what that
    means, because the honest answer differs by rule. For intrusion it must
    refuse to run; for crowd density it means the whole frame.
    """
    return any(point_in_polygon(pt, p) for p in polys)


def total_area(polys) -> float:
    """Combined area in px^2. Overlaps are counted twice — good enough for the
    density figure this feeds, and far cheaper than true polygon union."""
    return sum(polygon_area(p) for p in polys)


def point_in_polygon(pt, poly) -> bool:
    """Ray-casting point-in-polygon. Empty polygon means 'no zone' -> True,
    so an unconfigured rule watches the whole frame instead of nothing."""
    if not poly:
        return True
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        # Does the edge straddle the horizontal ray, and where does it cross?
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1
            if x < xin:
                inside = not inside
    return inside


def polygon_area(poly) -> float:
    """Shoelace area in px^2. 0 for an empty/degenerate polygon."""
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


class CountingLine:
    """Counts a track ONCE when it crosses, with direction.

    Counting presence instead of crossings makes a person standing in view
    contribute on every frame. Same reasoning as the vehicle module.
    """

    def __init__(self, spec: str, ttl_frames: int = 3000):
        self.enabled = bool(spec and spec.strip())
        self.counted: dict[int, tuple[str, int]] = {}
        self.prev_side: dict[int, float] = {}
        self.ttl_frames = ttl_frames
        if self.enabled:
            x1, y1, x2, y2 = (float(v) for v in spec.split(","))
            self.p1, self.p2 = (x1, y1), (x2, y2)

    def _side(self, px, py) -> float:
        (x1, y1), (x2, y2) = self.p1, self.p2
        return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)

    def check(self, track_id: int, pt, frame_no: int = 0) -> str | None:
        if not self.enabled or track_id < 0 or track_id in self.counted:
            return None
        s = self._side(*pt)
        prev = self.prev_side.get(track_id)
        self.prev_side[track_id] = s
        if prev is None or s == 0 or (prev > 0) == (s > 0):
            return None
        direction = "in" if s > 0 else "out"
        self.counted[track_id] = (direction, frame_no)
        return direction

    def forget(self, keep: set, frame_no: int = 0) -> None:
        for tid in list(self.prev_side):
            if tid not in keep:
                self.prev_side.pop(tid, None)
        # Bound memory on a 24/7 worker: track ids are issued indefinitely.
        if frame_no and frame_no % 500 == 0:
            cutoff = frame_no - self.ttl_frames
            for tid, (_, seen) in list(self.counted.items()):
                if seen < cutoff and tid not in keep:
                    self.counted.pop(tid, None)
