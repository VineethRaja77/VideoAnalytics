"""Tests for the vehicle rule features (wrong_way, illegal_parking,
congestion, triple_riding).

All four run on detections the worker already produces — no extra model — so
these tests are pure logic and fast.

Run:  python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.rules import build_vehicle_rules, VEHICLE_RULES  # noqa: E402


class D:
    """Stand-in for pipeline.detect.Detection."""

    def __init__(self, track_id, bbox, cls_name="car", conf=0.9):
        self.track_id = track_id
        self.bbox = bbox
        self.cls_name = cls_name
        self.conf = conf

    @property
    def centroid(self):
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)


class Cfg:
    WRONG_WAY_ALLOWED = "in"
    PARKING_ZONE = "100,100,300,100,300,300,100,300"
    PARKING_SECONDS = 10.0
    PARKING_MOVE_FRACTION = 0.15
    CONGESTION_ZONE = ""
    CONGESTION_LIMIT = 3
    CONGESTION_WINDOW_FRAMES = 3
    TRIPLE_RIDING_PEOPLE = 3
    TRIPLE_RIDING_OVERLAP = 0.4
    ALERT_COOLDOWN_S = 60


def rule(name, cfg=None):
    return build_vehicle_rules([name], cfg or Cfg())[0]


class TestWrongWay(unittest.TestCase):
    def test_allowed_direction_is_silent(self):
        r = rule("wrong_way")
        d = D(1, (150, 150, 190, 200))
        self.assertEqual(r.update([d], {1: "in"}, 1, 100.0), [])

    def test_opposite_direction_alerts(self):
        r = rule("wrong_way")
        d = D(1, (150, 150, 190, 200), cls_name="truck")
        out = r.update([d], {1: "out"}, 1, 100.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "wrong_way")
        self.assertEqual(out[0]["vehicleType"], "truck")

    def test_no_crossing_no_alert(self):
        r = rule("wrong_way")
        self.assertEqual(r.update([D(1, (150, 150, 190, 200))], {}, 1, 100.0), [])

    def test_cooldown_prevents_repeat(self):
        r = rule("wrong_way")
        d = D(1, (150, 150, 190, 200))
        self.assertEqual(len(r.update([d], {1: "out"}, 1, 100.0)), 1)
        self.assertEqual(r.update([d], {1: "out"}, 2, 101.0), [])


class TestIllegalParking(unittest.TestCase):
    def test_moving_vehicle_never_alerts(self):
        r = rule("illegal_parking")
        for i in range(30):
            d = D(1, (150 + i * 5, 150, 190 + i * 5, 200))
            self.assertEqual(r.update([d], {}, i, 100.0 + i), [])

    def test_stationary_vehicle_alerts_after_threshold(self):
        r = rule("illegal_parking")
        d = D(1, (150, 150, 190, 200))
        self.assertEqual(r.update([d], {}, 1, 100.0), [])
        self.assertEqual(r.update([d], {}, 2, 105.0), [])      # 5s < 10s
        out = r.update([d], {}, 3, 112.0)                       # 12s
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "illegal_parking")
        self.assertGreaterEqual(out[0]["stationarySeconds"], 10.0)

    def test_vehicle_outside_zone_ignored(self):
        r = rule("illegal_parking")
        d = D(1, (10, 10, 50, 60))          # centroid outside the square
        for i in range(20):
            self.assertEqual(r.update([d], {}, i, 100.0 + i * 5), [])

    def test_movement_tolerance_scales_with_box_size(self):
        """A distant vehicle covers fewer pixels for the same real motion, so a
        fixed pixel threshold would call every far-away moving vehicle parked."""
        r = rule("illegal_parking")
        # Small (distant) box moving 8px — that is large relative to its size.
        for i in range(4):
            d = D(1, (150 + i * 8, 150, 170 + i * 8, 170))
            out = r.update([d], {}, i, 100.0 + i * 6)
        self.assertEqual(out, [], "small box moving should reset the parking clock")

    def test_leaving_resets_the_clock(self):
        r = rule("illegal_parking")
        inside = D(1, (150, 150, 190, 200))
        outside = D(1, (10, 10, 50, 60))
        r.update([inside], {}, 1, 100.0)
        r.update([outside], {}, 2, 105.0)          # left the zone
        self.assertEqual(r.update([inside], {}, 3, 108.0), [])   # clock restarted


class TestCongestion(unittest.TestCase):
    def test_below_limit_silent(self):
        r = rule("congestion")
        two = [D(i, (150, 150, 190, 200)) for i in range(2)]
        for i in range(10):
            self.assertEqual(r.update(two, {}, i, 100.0 + i), [])

    def test_above_limit_alerts(self):
        r = rule("congestion")
        many = [D(i, (150, 150, 190, 200)) for i in range(5)]
        out = r.update(many, {}, 1, 100.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "congestion")
        self.assertEqual(out[0]["count"], 5)

    def test_single_dropped_frame_does_not_clear(self):
        """Detection loses a vehicle constantly; the median holds through it."""
        class NoCd(Cfg):
            ALERT_COOLDOWN_S = 0
        r = rule("congestion", NoCd())
        many = [D(i, (150, 150, 190, 200)) for i in range(5)]
        r.update(many, {}, 1, 100.0)
        out = r.update(many[:1], {}, 2, 101.0)      # blip
        self.assertTrue(any(e["type"] == "congestion" for e in out), out)

    def test_hysteresis_on_clearing(self):
        """Clearing at the same threshold it triggered on would oscillate."""
        class NoCd(Cfg):
            ALERT_COOLDOWN_S = 0
        r = rule("congestion", NoCd())
        many = [D(i, (150, 150, 190, 200)) for i in range(5)]
        r.update(many, {}, 1, 100.0)
        # Collect ALL events: the clear fires on whichever frame the median
        # first drops below the hysteresis floor, not necessarily the last.
        out = []
        for i in range(2, 8):
            out += r.update([], {}, i, 100.0 + i)     # empty road
        self.assertTrue(any(e["type"] == "congestion_cleared" for e in out), out)


class TestTripleRiding(unittest.TestCase):
    def test_silent_without_person_boxes(self):
        """The vehicle model has no person class. Guessing rider count from the
        two-wheeler box alone cannot distinguish two riders from three, so the
        rule stays silent rather than inventing violations."""
        r = rule("triple_riding")
        bike = D(1, (100, 100, 160, 200), cls_name="two_wheeler")
        self.assertEqual(r.update([bike], {}, 1, 100.0, person_boxes=None), [])

    def test_three_riders_alerts(self):
        r = rule("triple_riding")
        bike = D(1, (100, 100, 160, 200), cls_name="two_wheeler")
        people = [(110, 110, 130, 160), (115, 115, 135, 165), (120, 120, 140, 170)]
        # Accumulate: the alert fires once the median over 3 frames is reached,
        # then the cooldown silences later frames.
        out = []
        for f in range(1, 5):
            out += r.update([bike], {}, f, 100.0 + f, person_boxes=people)
        self.assertTrue(out, "3 overlapping riders should alert")
        self.assertEqual(out[0]["type"], "triple_riding")
        self.assertGreaterEqual(out[0]["riders"], 3)

    def test_two_riders_do_not_alert(self):
        r = rule("triple_riding")
        bike = D(1, (100, 100, 160, 200), cls_name="two_wheeler")
        people = [(110, 110, 130, 160), (115, 115, 135, 165)]
        for f in range(1, 6):
            out = r.update([bike], {}, f, 100.0 + f, person_boxes=people)
            self.assertEqual(out, [])

    def test_bystander_not_counted_as_rider(self):
        """Someone standing next to the bike barely overlaps it."""
        r = rule("triple_riding")
        bike = D(1, (100, 100, 160, 200), cls_name="two_wheeler")
        people = [(110, 110, 130, 160), (115, 115, 135, 165), (300, 300, 320, 350)]
        for f in range(1, 6):
            out = r.update([bike], {}, f, 100.0 + f, person_boxes=people)
            self.assertEqual(out, [])

    def test_cars_are_ignored(self):
        r = rule("triple_riding")
        car = D(1, (100, 100, 160, 200), cls_name="car")
        people = [(110, 110, 130, 160), (115, 115, 135, 165), (120, 120, 140, 170)]
        for f in range(1, 6):
            self.assertEqual(r.update([car], {}, f, 100.0 + f, person_boxes=people), [])


class TestRegistry(unittest.TestCase):
    def test_vehicle_count_is_not_a_rule(self):
        """Counting is the worker's own job, so it must not also appear as a
        rule — that would double-count every crossing."""
        self.assertEqual(build_vehicle_rules(["vehicle_count"], Cfg()), [])

    def test_only_licensed_features_built(self):
        rules = build_vehicle_rules(["wrong_way", "congestion"], Cfg())
        self.assertEqual([r.feature for r in rules], ["wrong_way", "congestion"])

    def test_unknown_feature_skipped_not_fatal(self):
        rules = build_vehicle_rules(["wrong_way", "hovercraft"], Cfg())
        self.assertEqual([r.feature for r in rules], ["wrong_way"])

    def test_all_four_constructible(self):
        names = ["wrong_way", "illegal_parking", "congestion", "triple_riding"]
        self.assertEqual(len(build_vehicle_rules(names, Cfg())), 4)
        self.assertEqual(sorted(VEHICLE_RULES), sorted(names))


if __name__ == "__main__":
    unittest.main(verbosity=2)
