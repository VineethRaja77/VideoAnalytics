"""Regression tests for face recognition open-set behaviour.

The single requirement that matters here: an unenrolled person must come out as
UNKNOWN and must never be assigned to the nearest enrolled identity. These tests
pin that, plus the identity-voting rules.

Run:  ../.venv/bin/python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.gallery import Gallery, UNKNOWN  # noqa: E402
from pipeline.temporal import IdentityVoter  # noqa: E402


def unit(v):
    """L2-normalise — embeddings live on a hypersphere, so cosine == dot."""
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def basis(i, dim=512):
    v = np.zeros(dim, dtype=np.float32)
    v[i] = 1.0
    return v


class TestGalleryOpenSet(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.g = Gallery(os.path.join(self.tmp, "g.npz"))

    def test_empty_gallery_returns_unknown(self):
        name, sim, _ = self.g.match(unit(np.random.randn(512)), 0.4)
        self.assertEqual(name, UNKNOWN)
        self.assertEqual(sim, 0.0)

    def test_exact_match_identifies(self):
        self.g.add("ramesh", basis(0))
        name, sim, _ = self.g.match(basis(0), 0.4)
        self.assertEqual(name, "ramesh")
        self.assertAlmostEqual(sim, 1.0, places=5)

    def test_stranger_is_unknown_not_nearest_person(self):
        """THE core requirement: a stranger must not be forced onto whoever is
        closest. A softmax classifier cannot express this; a threshold can."""
        self.g.add("ramesh", basis(0))
        self.g.add("priya", basis(1))
        stranger = basis(400)  # orthogonal to everyone enrolled
        name, sim, _ = self.g.match(stranger, 0.4)
        self.assertEqual(name, UNKNOWN)
        self.assertLess(sim, 0.4)

    def test_margin_guard_rejects_ambiguous_match(self):
        """Both scores can clear the threshold and still be a coin flip.
        Being unsure between two people is not a reason to pick one."""
        self.g.add("twin_a", basis(0))
        self.g.add("twin_b", basis(1))
        halfway = unit(basis(0) + basis(1))  # 0.707 to each — both above 0.4
        name, sim, runner = self.g.match(halfway, 0.4, margin=0.05)
        self.assertEqual(name, UNKNOWN)
        self.assertGreater(sim, 0.4, "precondition: score is above threshold")
        self.assertAlmostEqual(sim, runner, places=5)

    def test_margin_guard_allows_clear_winner(self):
        self.g.add("ramesh", basis(0))
        self.g.add("priya", basis(1))
        near_ramesh = unit(basis(0) * 0.95 + basis(1) * 0.10)
        self.assertEqual(self.g.match(near_ramesh, 0.4, margin=0.05)[0], "ramesh")

    def test_threshold_is_respected(self):
        self.g.add("ramesh", basis(0))
        weak = unit(basis(0) * 0.5 + basis(300) * 0.866)  # cos ≈ 0.5
        self.assertEqual(self.g.match(weak, 0.6)[0], UNKNOWN)  # above 0.5 → reject
        self.assertEqual(self.g.match(weak, 0.4)[0], "ramesh")  # below 0.5 → accept

    def test_score_is_per_person_not_per_image(self):
        """Someone enrolled with 5 photos must not outvote someone with 1."""
        for k in range(5):
            self.g.add("many", unit(basis(0) + 0.01 * basis(10 + k)))
        self.g.add("one", basis(1))
        self.assertEqual(self.g.match(basis(1), 0.4)[0], "one")

    def test_multiple_images_improve_recall(self):
        self.g.add("ramesh", np.stack([basis(0), basis(5)]))
        self.assertEqual(self.g.match(basis(5), 0.4)[0], "ramesh")

    def test_remove_is_instant_and_complete(self):
        """Removing a person is deleting rows — no retraining involved."""
        self.g.add("ramesh", np.stack([basis(0), basis(2)]))
        self.g.add("priya", basis(1))
        self.assertEqual(self.g.remove("ramesh"), 2)
        self.assertEqual(self.g.people, ["priya"])
        self.assertEqual(self.g.match(basis(0), 0.4)[0], UNKNOWN)

    def test_persistence_round_trip(self):
        self.g.add("ramesh", basis(0))
        self.g.add("priya", basis(1))
        self.g.save()
        reloaded = Gallery(self.g.path)
        self.assertEqual(reloaded.people, ["priya", "ramesh"])
        self.assertEqual(len(reloaded), 2)
        self.assertEqual(reloaded.match(basis(0), 0.4)[0], "ramesh")

    def test_empty_gallery_survives_save_reload(self):
        """--replace with no valid images must not corrupt the store."""
        self.g.save()
        reloaded = Gallery(self.g.path)
        self.assertEqual(len(reloaded), 0)
        self.assertEqual(reloaded.match(basis(0), 0.4)[0], UNKNOWN)


class TestIdentityVoter(unittest.TestCase):
    def setUp(self):
        self.v = IdentityVoter(window=30, min_frames=3, lock_frames=5)

    def test_no_identity_before_min_frames(self):
        self.v.update(1, "ramesh", 0.8, 1)
        self.assertEqual(self.v.identity(1), (None, False))

    def test_locks_on_consistent_identity(self):
        for f in range(1, 7):
            self.v.update(1, "ramesh", 0.8, f)
        self.assertEqual(self.v.identity(1), ("ramesh", True))

    def test_unknown_votes_compete_fairly(self):
        """A genuinely unenrolled person should settle on UNKNOWN, not get
        captured by whichever face they drifted closest to once."""
        for f in range(1, 10):
            self.v.update(1, UNKNOWN, 0.0, f)
        self.v.update(1, "ramesh", 0.45, 10)
        self.assertEqual(self.v.identity(1)[0], UNKNOWN)

    def test_near_tie_does_not_lock_an_identity(self):
        """Naming someone from a 3-vs-2 split is worse than staying undecided."""
        for f in range(1, 21):
            self.v.update(1, "ramesh" if f % 2 else "priya", 0.7, f)
        self.assertFalse(self.v.identity(1)[1])

    def test_grace_preserves_votes_when_face_turns_away(self):
        for f in range(1, 5):
            self.v.update(1, "ramesh", 0.8, f)
        self.v.forget_absent(set(), 5, grace=20)
        self.assertIn(1, self.v.history)

    def test_purges_after_grace(self):
        for f in range(1, 5):
            self.v.update(1, "ramesh", 0.8, f)
        self.v.forget_absent(set(), 100, grace=20)
        self.assertNotIn(1, self.v.history)


if __name__ == "__main__":
    unittest.main(verbosity=2)
