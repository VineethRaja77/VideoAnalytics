"""The seven person analytics, as rules over one shared set of tracks.

Detection and tracking run ONCE per frame; each enabled rule then reads the same
tracks. That is why they live in one worker: six separate processes would
recompute identical boxes six times.

Only rules named in ENABLED_FEATURES are constructed, so an unlicensed feature
costs nothing at runtime — it is not merely hidden, it does not exist.

Every rule returns event dicts; the worker adds camera/timestamp and posts them.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from .zones import (
    CountingLine, feet, parse_polygon, parse_polygons, point_in_any,
    point_in_polygon, polygon_area, total_area,
)


class RuleNotConfigured(Exception):
    """A licensed rule cannot run until an operator configures it.

    Distinct from a crash: the client bought the feature and the worker is
    healthy, but a required zone or line has not been drawn yet. The supervisor
    surfaces this to the client admin as a configuration prompt rather than
    restart-looping a worker that can never succeed.
    """


class Rule:
    """Base rule. `update` gets every tracked person in the current frame."""

    feature: str = ""

    def __init__(self, cfg):
        self.cfg = cfg

    def update(self, tracks, frame_no: int, now: float) -> list[dict]:
        return []

    def forget(self, keep: set, frame_no: int) -> None:
        pass


# ----------------------------------------------------------------- intrusion
class IntrusionRule(Rule):
    """Someone entered a restricted polygon.

    Fires once per track per entry, not once per frame, and only after the
    person has been inside for MIN_FRAMES — a single frame of a box clipping a
    zone corner is a false alarm, and at 6 fps that happens constantly on
    boundaries.
    """

    feature = "intrusion"

    #: A zone is MANDATORY for this rule. point_in_polygon() treats an empty
    #: polygon as "everywhere", which for counting or density is a sensible
    #: default but for intrusion is a trap: enabling the feature before drawing
    #: a zone would raise an intrusion alert for EVERY person in frame, at
    #: sample_fps, forever. The first thing an operator does with a system that
    #: does that is switch it off. "Restricted area" with no area defined is not
    #: a permissive default, it is a misconfiguration.
    requires_zone = True

    def __init__(self, cfg):
        super().__init__(cfg)
        # SEVERAL areas, not one. A yard camera routinely covers a fuel store
        # and a transformer bay; forcing them into one polygon means either
        # covering the walkway between them (false alerts all day) or leaving
        # one of them unwatched.
        self.zones = parse_polygons(cfg.INTRUSION_ZONE)
        if not self.zones:
            raise RuleNotConfigured(
                "intrusion needs a restricted zone. Draw one on the camera in "
                "Analytics settings, or set INTRUSION_ZONE to a polygon "
                '("x1,y1,x2,y2,x3,y3,..."). Refusing to run: with no zone every '
                "person in frame is an intruder."
            )
        self.min_frames = cfg.INTRUSION_MIN_FRAMES
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.inside_since: dict[int, int] = {}
        self.alerted: dict[int, float] = {}

    def update(self, tracks, frame_no, now):
        out = []
        present = set()
        for t in tracks:
            inside = point_in_any(feet(t.bbox), self.zones)
            if not inside:
                self.inside_since.pop(t.track_id, None)
                continue
            present.add(t.track_id)
            first = self.inside_since.setdefault(t.track_id, frame_no)
            if frame_no - first < self.min_frames:
                continue
            if now - self.alerted.get(t.track_id, 0) < self.cooldown:
                continue
            self.alerted[t.track_id] = now
            out.append({
                "type": "intrusion",
                "trackId": t.track_id,
                "framesInside": frame_no - first,
                "bbox": list(t.bbox),
            })
        return out

    def forget(self, keep, frame_no):
        for d in (self.inside_since, self.alerted):
            for tid in list(d):
                if tid not in keep:
                    d.pop(tid, None)


# ------------------------------------------------------------- people count
class PeopleCountRule(Rule):
    """Line-crossing footfall, plus periodic occupancy.

    Counts crossings rather than presence so a person standing in view is
    counted once, not once per frame.
    """

    feature = "people_count"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.line = CountingLine(cfg.COUNT_LINE)
        self.interval = cfg.COUNT_SUMMARY_INTERVAL_S
        self.last_summary = time.time()
        self.window = {"in": 0, "out": 0}
        self.total = {"in": 0, "out": 0}

    def update(self, tracks, frame_no, now):
        out = []
        for t in tracks:
            d = self.line.check(t.track_id, feet(t.bbox), frame_no)
            if d:
                self.window[d] += 1
                self.total[d] += 1
                out.append({
                    "type": "people_crossed",
                    "trackId": t.track_id,
                    "direction": d,
                    "bbox": list(t.bbox),
                })
        if self.interval and now - self.last_summary >= self.interval:
            # Emit the DELTA for the window; sending cumulative totals with a
            # window field makes every summary look like ever-growing traffic.
            if self.window["in"] or self.window["out"] or tracks:
                out.append({
                    "type": "people_count_summary",
                    "in": self.window["in"],
                    "out": self.window["out"],
                    "occupancy": len(tracks),
                    "windowSeconds": round(now - self.last_summary, 1),
                })
            self.window = {"in": 0, "out": 0}
            self.last_summary = now
        return out

    def forget(self, keep, frame_no):
        self.line.forget(keep, frame_no)


# ---------------------------------------------------------------- loitering
class LoiteringRule(Rule):
    """Someone stayed in the zone longer than a dwell threshold.

    Dwell is measured in wall-clock seconds, not frames, so the threshold means
    the same thing regardless of SAMPLE_FPS or a slow frame.
    """

    feature = "loitering"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.zones = parse_polygons(cfg.LOITER_ZONE or cfg.INTRUSION_ZONE)
        self.seconds = cfg.LOITER_SECONDS
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.since: dict[int, float] = {}
        self.alerted: dict[int, float] = {}

    def update(self, tracks, frame_no, now):
        out = []
        for t in tracks:
            # No areas drawn = watch the whole frame, which is the sensible
            # default for loitering (unlike intrusion, where it means everyone).
            if self.zones and not point_in_any(feet(t.bbox), self.zones):
                self.since.pop(t.track_id, None)
                continue
            start = self.since.setdefault(t.track_id, now)
            dwell = now - start
            if dwell < self.seconds:
                continue
            if now - self.alerted.get(t.track_id, 0) < self.cooldown:
                continue
            self.alerted[t.track_id] = now
            out.append({
                "type": "loitering",
                "trackId": t.track_id,
                "dwellSeconds": round(dwell, 1),
                "bbox": list(t.bbox),
            })
        return out

    def forget(self, keep, frame_no):
        for d in (self.since, self.alerted):
            for tid in list(d):
                if tid not in keep:
                    d.pop(tid, None)


# ----------------------------------------------------------- crowd density
class CrowdDensityRule(Rule):
    """Too many people in the zone at once.

    Uses a rolling median rather than the instantaneous count: detection drops
    a person for a frame constantly, and a raw count would flap around the
    threshold and emit a burst of alerts.
    """

    feature = "crowd_density"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.zones = parse_polygons(cfg.CROWD_ZONE or cfg.INTRUSION_ZONE)
        self.limit = cfg.CROWD_LIMIT
        self.window = deque(maxlen=max(1, cfg.CROWD_WINDOW_FRAMES))
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.last_alert = 0.0
        self.area_px = total_area(self.zones)

    def update(self, tracks, frame_no, now):
        n = sum(1 for t in tracks
                if not self.zones or point_in_any(feet(t.bbox), self.zones))
        self.window.append(n)
        s = sorted(self.window)
        median = s[len(s) // 2]
        if median < self.limit or now - self.last_alert < self.cooldown:
            return []
        self.last_alert = now
        ev = {
            "type": "crowd_density",
            "count": median,
            "limit": self.limit,
            "instantaneous": n,
        }
        if self.area_px > 0:
            ev["perSqPx"] = round(median / self.area_px, 8)
        return [ev]


# ------------------------------------------------------------- queue / dwell
class QueueDwellRule(Rule):
    """Queue length and average wait in a zone.

    Wait time is the mean dwell of everyone currently in the zone — a live
    estimate, not a completed-service measurement.
    """

    feature = "queue_dwell"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.zones = parse_polygons(cfg.QUEUE_ZONE or cfg.INTRUSION_ZONE)
        if not self.zones:
            raise RuleNotConfigured(
                "queue_dwell needs a queue area. Draw one on the camera in "
                "Analytics settings, or set QUEUE_ZONE."
            )
        self.interval = cfg.QUEUE_SUMMARY_INTERVAL_S
        self.last = time.time()
        self.since: dict[int, float] = {}

    def update(self, tracks, frame_no, now):
        in_zone = [t for t in tracks if point_in_any(feet(t.bbox), self.zones)]
        ids = {t.track_id for t in in_zone}
        for t in in_zone:
            self.since.setdefault(t.track_id, now)
        for tid in list(self.since):
            if tid not in ids:
                self.since.pop(tid, None)

        if not self.interval or now - self.last < self.interval:
            return []
        self.last = now
        waits = [now - s for s in self.since.values()]
        return [{
            "type": "queue_status",
            "queueLength": len(in_zone),
            "avgWaitSeconds": round(sum(waits) / len(waits), 1) if waits else 0.0,
            "maxWaitSeconds": round(max(waits), 1) if waits else 0.0,
        }]

    def forget(self, keep, frame_no):
        for tid in list(self.since):
            if tid not in keep:
                self.since.pop(tid, None)


# --------------------------------------------------------------- tailgating
class TailgatingRule(Rule):
    """Two or more people crossing a line within a short window.

    Genuine tailgating detection needs an access-control signal (one badge, two
    bodies). Without that this reports the vision half only: N crossings inside
    TAILGATE_WINDOW_S. Correlate it with a door event to call it a violation.
    """

    feature = "tailgating"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.line = CountingLine(cfg.TAILGATE_LINE or cfg.COUNT_LINE)
        self.window_s = cfg.TAILGATE_WINDOW_S
        self.threshold = cfg.TAILGATE_PEOPLE
        self.recent: deque = deque()
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.last_alert = 0.0

    def update(self, tracks, frame_no, now):
        for t in tracks:
            if self.line.check(t.track_id, feet(t.bbox), frame_no):
                self.recent.append((now, t.track_id))
        while self.recent and now - self.recent[0][0] > self.window_s:
            self.recent.popleft()
        if len(self.recent) < self.threshold or now - self.last_alert < self.cooldown:
            return []
        self.last_alert = now
        return [{
            "type": "tailgating",
            "peopleInWindow": len(self.recent),
            "windowSeconds": self.window_s,
            "trackIds": [tid for _, tid in self.recent],
        }]

    def forget(self, keep, frame_no):
        self.line.forget(keep, frame_no)


# --------------------------------------------------------------------- fall
class FallRule(Rule):
    """Fall detection from box geometry — no pose model, no extra weights.

    A standing person's box is tall (aspect w/h well under 1); a fallen one is
    wide. The rule fires when a track's aspect flips past a threshold AND its
    box bottom drops sharply, then stays that way for HOLD_S — the hold is what
    separates a fall from someone crouching or the box briefly deforming.

    ACCURACY: this is a heuristic, materially weaker than a pose-based detector,
    and it misses falls toward or away from the camera where the box stays tall.
    It was chosen because every Apache/MIT pose model would add a dependency
    whose weight licence I have not verified. Treat its output as "possible
    fall, review the snapshot", not as ground truth.
    """

    feature = "fall"

    def __init__(self, cfg):
        super().__init__(cfg)
        self.ar_thresh = cfg.FALL_ASPECT
        self.drop_frac = cfg.FALL_DROP_FRACTION
        self.hold_s = cfg.FALL_HOLD_S
        self.cooldown = cfg.ALERT_COOLDOWN_S
        self.hist: dict[int, deque] = defaultdict(lambda: deque(maxlen=30))
        self.down_since: dict[int, float] = {}
        self.alerted: dict[int, float] = {}

    def update(self, tracks, frame_no, now):
        out = []
        for t in tracks:
            x1, y1, x2, y2 = t.bbox
            w, h = x2 - x1, y2 - y1
            if h <= 0:
                continue
            ar = w / h
            self.hist[t.track_id].append((now, ar, y2, h))

            hist = self.hist[t.track_id]
            if len(hist) < 3:
                continue

            # Reference height from earlier in the track, before any collapse.
            ref_h = max(e[3] for e in hist)
            _, _, y2_old, _ = hist[0]
            dropped = (y2 - y2_old) > self.drop_frac * ref_h

            if ar >= self.ar_thresh and dropped:
                start = self.down_since.setdefault(t.track_id, now)
                if now - start < self.hold_s:
                    continue
                if now - self.alerted.get(t.track_id, 0) < self.cooldown:
                    continue
                self.alerted[t.track_id] = now
                out.append({
                    "type": "fall",
                    "trackId": t.track_id,
                    "aspectRatio": round(ar, 2),
                    "downSeconds": round(now - start, 1),
                    "bbox": list(t.bbox),
                    "confidence": "heuristic",
                })
            else:
                self.down_since.pop(t.track_id, None)
        return out

    def forget(self, keep, frame_no):
        for d in (self.hist, self.down_since, self.alerted):
            for tid in list(d):
                if tid not in keep:
                    d.pop(tid, None)


RULES: dict[str, type[Rule]] = {
    r.feature: r
    for r in (IntrusionRule, PeopleCountRule, LoiteringRule, CrowdDensityRule,
              QueueDwellRule, TailgatingRule, FallRule)
}


def build_rules(features, cfg, report: list | None = None) -> list[Rule]:
    """Instantiate ONLY the licensed features. An unknown name is skipped with a
    warning rather than crashing the worker — the platform is the authority on
    what is licensed, and a newer server may know features this build does not.

    `report`, if given, is filled with (feature, reason) for every licensed rule
    that could not start because it still needs configuring. The caller needs
    that to tell "this camera is waiting for a zone to be drawn" apart from
    "this worker is broken" — the first must not be restart-looped."""
    out = []
    unconfigured: list[tuple[str, str]] = report if report is not None else []
    for f in features:
        f = f.strip()
        if not f:
            continue
        cls = RULES.get(f)
        if cls is None:
            print(f"[rules] unknown feature '{f}' — skipping")
            continue
        try:
            out.append(cls(cfg))
        except RuleNotConfigured as e:
            # NOT a crash. The client owns this feature and the worker is fine;
            # an operator simply has not drawn the zone yet. Skip this one rule
            # and keep every other licensed feature running — killing the whole
            # worker would take down analytics the client HAS configured.
            print(f"[rules] '{f}' NOT STARTED — {e}")
            unconfigured.append((f, str(e)))
        except ValueError as e:
            # A MALFORMED zone or line — parse_polygon and CountingLine raise
            # ValueError on a bad spec. Treated exactly like "not configured"
            # rather than allowed to propagate: an uncaught exception here kills
            # the worker, and the supervisor then restart-loops it forever
            # against a config that can never parse. One bad polygon must not
            # take down the other six analytics on that camera.
            print(f"[rules] '{f}' NOT STARTED — bad geometry: {e}")
            unconfigured.append((f, f"bad geometry: {e}"))
    if unconfigured:
        print(f"[rules] {len(unconfigured)} licensed feature(s) await configuration: "
              f"{', '.join(f for f, _ in unconfigured)}")
    return out
