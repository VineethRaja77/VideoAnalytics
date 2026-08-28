"""Tests for the seven person analytics.

These pin behaviour whose failure is silent rather than loud: an alert that
fires every frame instead of once, a dwell timer that resets on occlusion, a
zone test that uses the wrong reference point. None of those raise.

Run:  ../.venv/bin/python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.rules import build_rules  # noqa: E402
from pipeline.zones import (  # noqa: E402
    CountingLine, feet, parse_polygon, point_in_polygon, polygon_area,
)


class T:
    """Minimal stand-in for pipeline.detect.Track."""

    def __init__(self, track_id, bbox, conf=0.9):
        self.track_id = track_id
        self.bbox = bbox
        self.conf = conf


class Cfg:
    """Config double — mirrors config.py's attribute names."""
    INTRUSION_ZONE = "100,100,300,100,300,300,100,300"   # square
    LOITER_ZONE = ""
    CROWD_ZONE = ""
    QUEUE_ZONE = ""
    COUNT_LINE = "0,200,400,200"
    TAILGATE_LINE = ""
    INTRUSION_MIN_FRAMES = 3
    COUNT_SUMMARY_INTERVAL_S = 0        # off in tests
    LOITER_SECONDS = 5
    CROWD_LIMIT = 3
    CROWD_WINDOW_FRAMES = 3
    QUEUE_SUMMARY_INTERVAL_S = 0
    TAILGATE_WINDOW_S = 3
    TAILGATE_PEOPLE = 2
    FALL_ASPECT = 1.0
    FALL_DROP_FRACTION = 0.15
    FALL_HOLD_S = 2.0
    ALERT_COOLDOWN_S = 60


def rule(name, cfg=None):
    return build_rules([name], cfg or Cfg())[0]


class TestZones(unittest.TestCase):
    def test_feet_is_bottom_centre_not_centroid(self):
        """Zone tests must use where the person STANDS. A centroid sits well
        above the feet on a tall box and fires early on approach."""
        self.assertEqual(feet((100, 0, 200, 400)), (150.0, 400.0))

    def test_point_in_polygon(self):
        sq = parse_polygon("0,0,10,0,10,10,0,10")
        self.assertTrue(point_in_polygon((5, 5), sq))
        self.assertFalse(point_in_polygon((15, 5), sq))

    def test_empty_polygon_means_whole_frame(self):
        """An unconfigured zone must watch everything, not nothing — otherwise
        a rule silently never fires."""
        self.assertTrue(point_in_polygon((5, 5), []))

    def test_bad_polygon_rejected(self):
        with self.assertRaises(ValueError):
            parse_polygon("1,2,3,4")          # only 2 points
        with self.assertRaises(ValueError):
            parse_polygon("1,2,3,4,5")        # odd count

    def test_polygon_area(self):
        self.assertAlmostEqual(polygon_area(parse_polygon("0,0,10,0,10,10,0,10")), 100.0)


class TestCountingLine(unittest.TestCase):
    def setUp(self):
        self.line = CountingLine("0,100,200,100")

    def test_no_count_on_first_sighting(self):
        self.assertIsNone(self.line.check(1, (50, 50), 1))

    def test_counts_once_then_never_again(self):
        self.line.check(1, (50, 50), 1)
        self.assertIsNotNone(self.line.check(1, (50, 150), 2))
        for f in range(3, 12):
            self.assertIsNone(self.line.check(1, (50, 50 if f % 2 else 150), f))

    def test_direction_is_signed(self):
        self.line.check(1, (50, 50), 1)
        d1 = self.line.check(1, (50, 150), 2)
        self.line.check(2, (50, 150), 1)
        d2 = self.line.check(2, (50, 50), 2)
        self.assertNotEqual(d1, d2)

    def test_counted_map_is_bounded(self):
        for tid in range(50):
            self.line.check(tid, (50, 50), 1)
            self.line.check(tid, (50, 150), 2)
        self.assertEqual(len(self.line.counted), 50)
        self.line.forget(set(), frame_no=1_000_000)
        self.assertEqual(len(self.line.counted), 0)


class TestIntrusion(unittest.TestCase):
    def test_ignores_person_outside_zone(self):
        r = rule("intrusion")
        for f in range(1, 10):
            self.assertEqual(r.update([T(1, (0, 0, 20, 50))], f, 100.0 + f), [])

    def test_requires_min_frames_inside(self):
        """One frame of a box clipping a zone corner is not an intrusion."""
        r = rule("intrusion")
        inside = T(1, (180, 150, 220, 200))     # feet (200,200) inside square
        self.assertEqual(r.update([inside], 1, 100.0), [])
        self.assertEqual(r.update([inside], 2, 101.0), [])
        self.assertEqual(len(r.update([inside], 4, 103.0)), 1)

    def test_fires_once_not_every_frame(self):
        r = rule("intrusion")
        inside = T(1, (180, 150, 220, 200))
        fired = sum(len(r.update([inside], f, 100.0 + f)) for f in range(1, 30))
        self.assertEqual(fired, 1, "intrusion must not re-alert every frame")

    def test_leaving_resets_the_dwell(self):
        r = rule("intrusion")
        inside, outside = T(1, (180, 150, 220, 200)), T(1, (0, 0, 20, 50))
        r.update([inside], 1, 100.0)
        r.update([outside], 2, 101.0)          # left
        self.assertEqual(r.update([inside], 3, 102.0), [])  # counter restarted


class TestLoitering(unittest.TestCase):
    def test_fires_only_after_dwell_seconds(self):
        r = rule("loitering")
        p = T(1, (180, 150, 220, 200))
        self.assertEqual(r.update([p], 1, 1000.0), [])
        self.assertEqual(r.update([p], 2, 1004.0), [])      # 4s < 5s
        out = r.update([p], 3, 1006.0)                       # 6s
        self.assertEqual(len(out), 1)
        self.assertGreaterEqual(out[0]["dwellSeconds"], 5)

    def test_dwell_is_wall_clock_not_frames(self):
        """Threshold must mean the same thing at any SAMPLE_FPS."""
        r = rule("loitering")
        p = T(1, (180, 150, 220, 200))
        r.update([p], 1, 1000.0)
        self.assertEqual(len(r.update([p], 2, 1006.0)), 1)   # 2 frames, 6 seconds


class TestCrowdDensity(unittest.TestCase):
    def test_below_limit_is_silent(self):
        r = rule("crowd_density")
        people = [T(i, (180, 150, 220, 200)) for i in range(2)]
        for f in range(1, 10):
            self.assertEqual(r.update(people, f, 100.0 + f), [])

    def test_smooths_a_single_dropped_frame(self):
        """A raw count would flap on/off as detection loses one person.

        Cooldown is disabled here so each frame's decision is visible; with the
        production 60s cooldown the first alert would mask the rest.
        """
        class NoCooldown(Cfg):
            ALERT_COOLDOWN_S = 0

        r = rule("crowd_density", NoCooldown())
        many = [T(i, (180, 150, 220, 200)) for i in range(5)]
        few = many[:1]

        first = r.update(many, 1, 101.0)
        self.assertEqual(first[0]["count"], 5)

        # One frame where the detector loses four people. The MEDIAN of (5,1)
        # is still 5, so the alert holds instead of flapping off.
        out = r.update(few, 2, 102.0)
        self.assertEqual(len(out), 1, "a single dropped frame must not clear the alert")
        self.assertEqual(out[0]["count"], 5)
        self.assertEqual(out[0]["instantaneous"], 1)

    def test_sustained_drop_does_clear_the_alert(self):
        """Smoothing must not make the alert sticky forever — once the crowd
        genuinely disperses it has to stop."""
        class NoCooldown(Cfg):
            ALERT_COOLDOWN_S = 0

        r = rule("crowd_density", NoCooldown())
        many = [T(i, (180, 150, 220, 200)) for i in range(5)]
        few = many[:1]
        r.update(many, 1, 101.0)
        for f in range(2, 6):
            out = r.update(few, f, 100.0 + f)
        self.assertEqual(out, [], "alert should clear once the count really drops")


class TestTailgating(unittest.TestCase):
    def test_two_crossings_in_window(self):
        r = rule("tailgating")
        a, b = T(1, (40, 40, 60, 90)), T(2, (40, 40, 60, 90))
        r.update([a, b], 1, 100.0)                                   # prime sides
        out = r.update([T(1, (40, 160, 60, 210)), T(2, (40, 160, 60, 210))], 2, 100.5)
        self.assertEqual(len(out), 1)
        self.assertGreaterEqual(out[0]["peopleInWindow"], 2)

    def test_spread_out_crossings_do_not_alert(self):
        r = rule("tailgating")
        r.update([T(1, (40, 40, 60, 90))], 1, 100.0)
        r.update([T(1, (40, 160, 60, 210))], 2, 100.2)
        r.update([T(2, (40, 40, 60, 90))], 3, 200.0)
        out = r.update([T(2, (40, 160, 60, 210))], 4, 200.2)   # 100s later
        self.assertEqual(out, [])


class TestFall(unittest.TestCase):
    def test_standing_person_never_alerts(self):
        r = rule("fall")
        for f in range(1, 20):
            self.assertEqual(r.update([T(1, (100, 0, 140, 200))], f, 100.0 + f), [])

    def test_fall_needs_hold_time(self):
        """A momentary wide box (crouch, box deformation) is not a fall."""
        r = rule("fall")
        r.update([T(1, (100, 0, 140, 200))], 1, 100.0)
        r.update([T(1, (100, 0, 140, 200))], 2, 100.5)
        fallen = T(1, (100, 170, 300, 240))          # wide, dropped
        self.assertEqual(r.update([fallen], 3, 101.0), [])     # < HOLD_S
        out = r.update([fallen], 4, 104.0)                     # held 3s
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "fall")

    def test_reports_itself_as_heuristic(self):
        """Downstream must know this is not a pose-based detector."""
        r = rule("fall")
        r.update([T(1, (100, 0, 140, 200))], 1, 100.0)
        r.update([T(1, (100, 0, 140, 200))], 2, 100.5)
        fallen = T(1, (100, 170, 300, 240))
        r.update([fallen], 3, 101.0)
        out = r.update([fallen], 4, 104.0)
        self.assertEqual(out[0]["confidence"], "heuristic")


class TestRuleRegistry(unittest.TestCase):
    def test_only_requested_features_are_built(self):
        """An unlicensed feature must not merely be hidden — it must not exist."""
        rules = build_rules(["intrusion", "fall"], Cfg())
        self.assertEqual([r.feature for r in rules], ["intrusion", "fall"])

    def test_unknown_feature_is_skipped_not_fatal(self):
        """A newer platform may license a feature this build does not have; the
        worker must still serve the ones it knows."""
        rules = build_rules(["intrusion", "teleportation"], Cfg())
        self.assertEqual([r.feature for r in rules], ["intrusion"])

    def test_all_seven_features_constructible(self):
        names = ["intrusion", "people_count", "loitering", "crowd_density",
                 "queue_dwell", "tailgating", "fall"]
        self.assertEqual(len(build_rules(names, Cfg())), 7)


if __name__ == "__main__":
    unittest.main(verbosity=2)
