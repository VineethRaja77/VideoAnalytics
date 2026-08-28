"""Regression tests for the vehicle pipeline logic.

Every test here corresponds to a bug that was actually found and fixed, or to an
invariant whose failure would be silent in production:

  * per-track voting resetting on brief occlusion  (destroyed the class lock,
    inflated the track count 73 vs 39)
  * the counting line double-counting or losing side-state
  * unbounded growth of the `counted` map on a 24/7 worker

Run:  ../.venv/bin/python -m pytest tests/ -q     (or: python -m unittest)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.temporal import TrackClassVoter  # noqa: E402
from pipeline.zone import CountingLine  # noqa: E402


class TestTrackClassVoter(unittest.TestCase):
    def setUp(self):
        self.v = TrackClassVoter(window=30, min_frames=3, lock_frames=5)

    def test_no_class_before_min_frames(self):
        """Reporting an identity from one frame is exactly the flicker bug."""
        self.v.update(1, "car", 0.9, 1)
        self.assertEqual(self.v.klass(1), (None, False))

    def test_majority_wins_after_min_frames(self):
        for f in range(1, 4):
            self.v.update(1, "car", 0.9, f)
        name, locked = self.v.klass(1)
        self.assertEqual(name, "car")
        self.assertFalse(locked)

    def test_locks_on_clear_majority(self):
        for f in range(1, 7):
            self.v.update(1, "car", 0.9, f)
        name, locked = self.v.klass(1)
        self.assertEqual(name, "car")
        self.assertTrue(locked)

    def test_locked_class_survives_bad_frames(self):
        """After locking, one bad frame must NOT change the vehicle's identity."""
        for f in range(1, 7):
            self.v.update(1, "car", 0.9, f)
        for f in range(7, 12):
            self.v.update(1, "van", 0.95, f)
        self.assertEqual(self.v.klass(1)[0], "car")

    def test_ambiguous_track_never_locks(self):
        """A genuine van/lcv toss-up should keep voting, not freeze a guess."""
        for f in range(1, 21):
            self.v.update(1, "van" if f % 2 else "lcv", 0.8, f)
        self.assertFalse(self.v.klass(1)[1])

    def test_confidence_weighting(self):
        """Votes are weighted by confidence, not counted equally."""
        self.v.update(1, "car", 0.99, 1)
        self.v.update(1, "car", 0.99, 2)
        self.v.update(1, "van", 0.20, 3)
        self.assertEqual(self.v.klass(1)[0], "car")

    def test_negative_track_id_ignored(self):
        self.v.update(-1, "car", 0.9, 1)
        self.assertEqual(len(self.v.history), 0)

    # ---- the occlusion bug ----
    def test_grace_period_preserves_votes_through_occlusion(self):
        """THE BUG: purging on first absence reset the vote every time a vehicle
        was briefly occluded, so a track never accumulated enough to lock."""
        for f in range(1, 5):
            self.v.update(1, "car", 0.9, f)
        # Missing from this frame — occluded, not gone.
        self.v.forget_absent(active_ids=set(), frame_no=5, grace=30)
        self.assertIn(1, self.v.history, "vote history dropped on brief absence")
        self.v.update(1, "car", 0.9, 6)
        self.assertTrue(self.v.klass(1)[1], "should have locked; votes were lost")

    def test_purges_after_grace_expires(self):
        for f in range(1, 5):
            self.v.update(1, "car", 0.9, f)
        self.v.forget_absent(active_ids=set(), frame_no=100, grace=30)
        self.assertNotIn(1, self.v.history)

    def test_track_count_not_inflated_by_occlusion(self):
        """73-vs-39 regression: re-creating purged tracks double-counted them."""
        for f in range(1, 5):
            self.v.update(1, "car", 0.9, f)
        self.v.forget_absent(set(), 5, grace=30)
        self.v.update(1, "car", 0.9, 6)
        self.assertEqual(self.v.total_tracks, 1)


class TestCountingLine(unittest.TestCase):
    def setUp(self):
        # Horizontal line across y=100.
        self.line = CountingLine("0,100,200,100", counted_ttl_frames=50)

    def test_disabled_when_unset(self):
        self.assertFalse(CountingLine("").enabled)
        self.assertIsNone(CountingLine("").check(1, (5, 5), 1))

    def test_no_count_on_first_sighting(self):
        """One position gives no direction — a crossing needs two sides."""
        self.assertIsNone(self.line.check(1, (50, 50), 1))

    def test_counts_once_on_crossing(self):
        self.assertIsNone(self.line.check(1, (50, 50), 1))
        self.assertIsNotNone(self.line.check(1, (50, 150), 2))

    def test_never_double_counts_same_track(self):
        """A vehicle lingering at the line must not count repeatedly."""
        self.line.check(1, (50, 50), 1)
        self.line.check(1, (50, 150), 2)
        for f in range(3, 20):
            y = 50 if f % 2 else 150
            self.assertIsNone(self.line.check(1, (50, y), f))

    def test_direction_is_reported(self):
        self.line.check(1, (50, 50), 1)
        d1 = self.line.check(1, (50, 150), 2)
        self.line.check(2, (50, 150), 1)
        d2 = self.line.check(2, (50, 50), 2)
        self.assertIn(d1, ("in", "out"))
        self.assertIn(d2, ("in", "out"))
        self.assertNotEqual(d1, d2, "opposite travel must give opposite direction")

    def test_no_count_without_crossing(self):
        for f in range(1, 10):
            self.line.check(1, (50, 50 + f), f)
        self.assertEqual(len(self.line.counted), 0)

    def test_separate_tracks_counted_separately(self):
        for tid in (1, 2, 3):
            self.line.check(tid, (50, 50), 1)
            self.line.check(tid, (50, 150), 2)
        self.assertEqual(len(self.line.counted), 3)

    # ---- the memory-leak fix ----
    def test_counted_map_is_bounded(self):
        """THE BUG: `counted` grew forever, leaking on a 24/7 worker."""
        for tid in range(1, 51):
            self.line.check(tid, (50, 50), 1)
            self.line.check(tid, (50, 150), 2)
        self.assertEqual(len(self.line.counted), 50)
        self.line.forget_absent(set(), set(), frame_no=1000)
        self.assertEqual(len(self.line.counted), 0, "TTL sweep did not reclaim entries")

    def test_active_tracks_not_swept(self):
        """A still-visible vehicle must keep its guard even past the TTL."""
        self.line.check(1, (50, 50), 1)
        self.line.check(1, (50, 150), 2)
        self.line.forget_absent({1}, {1}, frame_no=1000)
        self.assertIn(1, self.line.counted)


if __name__ == "__main__":
    unittest.main(verbosity=2)
