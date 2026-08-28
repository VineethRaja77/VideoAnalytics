"""Abandoned/removed object tests on synthetic scenes.

The interesting cases are the negative ones: a person walking through must NOT
be an abandoned object, and a brief pause must not either. Both fail silently
if the dual-background logic is wrong.

Run:  python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.detect import ObjectDetector, _iou  # noqa: E402

W, H = 320, 240
_noise = np.random.default_rng(7)


def empty_scene():
    """Plain room with some texture, plus fresh sensor noise each call."""
    img = np.full((H, W, 3), 70, np.uint8)
    img[: H // 3, :] = 120
    for y in range(0, H, 16):
        cv2.line(img, (0, y), (W, y), (95, 95, 95), 1)
    return np.clip(img.astype(np.int16) + _noise.integers(-3, 4, img.shape),
                   0, 255).astype(np.uint8)


def with_bag(x=140, y=140, w=44, h=40):
    """Empty scene plus a textured object — textured so it ADDS edges."""
    img = empty_scene()
    cv2.rectangle(img, (x, y), (x + w, y + h), (30, 30, 190), -1)
    for i in range(y, y + h, 6):
        cv2.line(img, (x, i), (x + w, i), (240, 240, 240), 1)
    return img


def scene_with_fixture():
    """A scene that already CONTAINS a textured object, so it can be removed."""
    return with_bag()


def person_at(x):
    img = empty_scene()
    cv2.rectangle(img, (x, 90), (x + 26, 200), (200, 200, 40), -1)
    return img


def det(**kw):
    base = dict(warmup_frames=5, persist_seconds=5.0, cooldown_seconds=0.0,
                min_area_frac=0.002, proc_width=320)
    base.update(kw)
    return ObjectDetector(**base)


def run(d, frame_fn, start, count, step=1.0):
    """Feed `count` frames, returning every event produced."""
    events = []
    t = start
    for i in range(count):
        events += d.update(frame_fn(i), t)
        t += step
    return events, t


class TestNoFalseAlarms(unittest.TestCase):
    def test_silent_during_warmup(self):
        d = det()
        ev, _ = run(d, lambda i: with_bag(), 1000.0, 5)
        self.assertEqual(ev, [])

    def test_empty_scene_never_alerts(self):
        d = det()
        ev, _ = run(d, lambda i: empty_scene(), 1000.0, 40)
        self.assertEqual(ev, [])

    def test_person_walking_through_is_not_abandoned(self):
        """THE case this method exists to get right: a moving person is
        foreground in BOTH background models, so the static mask excludes them."""
        d = det()
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev, _ = run(d, lambda i: person_at(20 + i * 22), 1100.0, 12)
        self.assertEqual([e for e in ev if e["type"] == "object_left"], [],
                         "a person walking through must not be an abandoned object")

    def test_brief_pause_does_not_alert(self):
        """An object present for less than PERSIST_SECONDS is not abandoned."""
        d = det(persist_seconds=30.0)
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev, _ = run(d, lambda i: with_bag(), 1100.0, 4)
        self.assertEqual([e for e in ev if e["type"] == "object_left"], [])


class TestLeftBehind(unittest.TestCase):
    def test_static_object_eventually_alerts(self):
        d = det(persist_seconds=4.0)
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev, _ = run(d, lambda i: with_bag(), 1100.0, 12)
        left = [e for e in ev if e["type"] == "object_left"]
        self.assertTrue(left, f"expected object_left, got {[e['type'] for e in ev]}")
        self.assertGreaterEqual(left[0]["staticSeconds"], 4.0)
        self.assertGreater(left[0]["edgeDensityNow"], left[0]["edgeDensityRef"])

    def test_alerts_once_not_every_frame(self):
        d = det(persist_seconds=4.0)
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev, _ = run(d, lambda i: with_bag(), 1100.0, 25)
        self.assertEqual(len([e for e in ev if e["type"] == "object_left"]), 1)

    def test_removal_is_reported_as_cleared(self):
        """Picking the bag back up must retract the alert."""
        d = det(persist_seconds=4.0, gone_seconds=2.0)
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev1, t = run(d, lambda i: with_bag(), 1100.0, 12)
        self.assertTrue([e for e in ev1 if e["type"] == "object_left"])
        ev2, _ = run(d, lambda i: empty_scene(), t, 15)
        self.assertTrue([e for e in ev2 if e["type"].endswith("_cleared")],
                        f"expected a cleared event, got {[e['type'] for e in ev2]}")


class TestRemoved(unittest.TestCase):
    def test_object_taken_away_reports_removed(self):
        """The edge test is what separates this from object_left — both look
        identical to a background subtractor on their own."""
        d = det(persist_seconds=4.0)
        run(d, lambda i: scene_with_fixture(), 1000.0, 10)   # learn WITH the object
        ev, _ = run(d, lambda i: empty_scene(), 1100.0, 14)  # object taken away
        removed = [e for e in ev if e["type"] == "object_removed"]
        self.assertTrue(removed, f"expected object_removed, got {[e['type'] for e in ev]}")
        self.assertLess(removed[0]["edgeDensityNow"], removed[0]["edgeDensityRef"])


class TestZoneMask(unittest.TestCase):
    def test_object_outside_the_zone_is_ignored(self):
        """Zone masking is how you stop a parked car counting as abandoned."""
        d = det(persist_seconds=4.0, zone_mask_spec="0,0,60,0,60,60,0,60")
        run(d, lambda i: empty_scene(), 1000.0, 8)
        ev, _ = run(d, lambda i: with_bag(x=200, y=150), 1100.0, 14)
        self.assertEqual([e for e in ev if e["type"] == "object_left"], [])


class TestHelpers(unittest.TestCase):
    def test_iou(self):
        self.assertAlmostEqual(_iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(_iou((0, 0, 10, 10), (50, 50, 60, 60)), 0.0)

    def test_status_reports_warmup(self):
        d = det()
        self.assertFalse(d.status()["warmedUp"])
        run(d, lambda i: empty_scene(), 1000.0, 8)
        self.assertTrue(d.status()["warmedUp"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
