"""Tests for the alert gate — when a face is worth telling the operator about.

Every case here was observed on a real 45-second clip before it was fixed. The
failures are not cosmetic: two of them mean an operator is shown noise until
they stop reading alerts, and one means a stranger walks in and nobody is told.
"""
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from pipeline.alerting import AlertGate, UNKNOWN  # noqa: E402

COOLDOWN = 60.0


def face(seed: int):
    """A normalised embedding standing in for one person's face."""
    rng = np.random.default_rng(seed)
    v = rng.normal(size=512).astype(np.float32)
    return v / np.linalg.norm(v)


def gate():
    return AlertGate(cooldown_s=COOLDOWN, unknown_same_person_sim=0.5,
                     track_identity_sim=0.45)


class OneAppearanceIsOneAlert(unittest.TestCase):
    def test_a_person_standing_in_view_is_announced_once(self):
        g, alice = gate(), face(1)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        # Recognised again on every sampled frame for the next minute.
        for t in range(1, 60):
            self.assertFalse(g.should_announce(1, "alice", alice, float(t)))

    def test_the_same_person_is_announced_again_after_the_cooldown(self):
        g, alice = gate(), face(1)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        self.assertTrue(g.should_announce(1, "alice", alice, COOLDOWN + 1))


class OnePersonIsOneAlert(unittest.TestCase):
    """A track id is not a person."""

    def test_a_new_track_id_for_the_same_person_does_not_re_alert(self):
        # What a stream reconnect does: same person, brand new track id. On the
        # real clip this produced three alerts for two people.
        g, alice = gate(), face(1)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        self.assertFalse(g.should_announce(2, "alice", alice, 10.0))
        self.assertFalse(g.should_announce(3, "alice", alice, 20.0))

    def test_a_different_person_is_never_suppressed_by_someone_else(self):
        g = gate()
        self.assertTrue(g.should_announce(1, "alice", face(1), 0.0))
        self.assertTrue(g.should_announce(2, "bob", face(2), 1.0))

    def test_the_person_cooldown_expires(self):
        g, alice = gate(), face(1)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        self.assertTrue(g.should_announce(9, "alice", alice, COOLDOWN + 0.1))


class UnknownsAreDeduplicatedByFaceNotByLabel(unittest.TestCase):
    """Every stranger is called "unknown", so the label cannot be the key."""

    def test_two_different_strangers_both_get_reported(self):
        # Suppressing by the word "unknown" would hide the second stranger —
        # the costlier error, because it is the one nobody finds out about.
        g = gate()
        self.assertTrue(g.should_announce(1, UNKNOWN, face(10), 0.0))
        self.assertTrue(g.should_announce(2, UNKNOWN, face(11), 5.0))
        self.assertTrue(g.should_announce(3, UNKNOWN, face(12), 9.0))

    def test_the_same_stranger_coming_back_is_not_reported_twice(self):
        g, stranger = gate(), face(10)
        self.assertTrue(g.should_announce(1, UNKNOWN, stranger, 0.0))
        self.assertFalse(g.should_announce(7, UNKNOWN, stranger, 30.0))

    def test_a_slightly_different_view_of_the_same_stranger_is_still_one_alert(self):
        g = gate()
        a = face(10)
        b = a + 0.35 * face(99)           # same person, different angle
        b = b / np.linalg.norm(b)
        self.assertGreater(float(a @ b), 0.5)
        self.assertTrue(g.should_announce(1, UNKNOWN, a, 0.0))
        self.assertFalse(g.should_announce(2, UNKNOWN, b, 4.0))

    def test_a_stranger_returning_after_the_cooldown_is_reported_again(self):
        g, stranger = gate(), face(10)
        self.assertTrue(g.should_announce(1, UNKNOWN, stranger, 0.0))
        self.assertTrue(g.should_announce(2, UNKNOWN, stranger, COOLDOWN + 1))


class TrackHijack(unittest.TestCase):
    """At a gate, the next person stands where the last one stood."""

    def test_a_different_face_on_one_track_id_is_detected(self):
        g = gate()
        self.assertFalse(g.track_changed(1, face(1)))    # first sighting
        self.assertFalse(g.track_changed(1, face(1)))    # same person again
        self.assertTrue(g.track_changed(1, face(2)))     # somebody else

    def test_the_same_person_moving_does_not_look_like_a_hijack(self):
        g = gate()
        a = face(1)
        moved = a + 0.4 * face(77)
        moved = moved / np.linalg.norm(moved)
        g.track_changed(1, a)
        self.assertFalse(g.track_changed(1, moved))

    def test_a_hijacked_track_lets_the_new_person_be_announced(self):
        # THE ONE THAT MATTERS. Without the reset the newcomer inherits the
        # departing person's cooldown and is never reported at all.
        g = gate()
        alice, stranger = face(1), face(2)
        g.track_changed(1, alice)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))

        self.assertTrue(g.track_changed(1, stranger))
        g.reset_track(1)
        self.assertTrue(g.should_announce(1, UNKNOWN, stranger, 5.0))

    def test_a_hijack_is_caught_even_if_the_caller_forgets_to_reset(self):
        # Two independent guards cover the newcomer, and that is deliberate:
        # this one (a CHANGED answer is news) needs the recognition result to
        # differ, while track_changed works on the face itself. The face check
        # is still the load-bearing one, because it is also what clears the
        # identity VOTE — without that, the newcomer's frames are tallied into
        # the departing person's identity and can outvote them.
        g = gate()
        alice, stranger = face(1), face(2)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        self.assertTrue(g.should_announce(1, UNKNOWN, stranger, 5.0))

    def test_a_hijack_by_someone_the_gallery_also_calls_unknown(self):
        # The case the changed-answer rule CANNOT catch: both people are
        # strangers, so the announced name is "unknown" both times and only the
        # face comparison can tell them apart.
        g = gate()
        first, second = face(10), face(11)
        g.track_changed(1, first)
        self.assertTrue(g.should_announce(1, UNKNOWN, first, 0.0))
        self.assertTrue(g.track_changed(1, second))
        g.reset_track(1)
        self.assertTrue(g.should_announce(1, UNKNOWN, second, 5.0))


class StateStaysBounded(unittest.TestCase):
    """A 24/7 worker issues track ids without limit."""

    def test_retired_tracks_are_forgotten(self):
        g = gate()
        for tid in range(200):
            g.track_changed(tid, face(tid))
            g.should_announce(tid, f"p{tid}", face(tid), 0.0)
        g.forget_absent(live_ids={1, 2}, now=COOLDOWN + 10)
        self.assertEqual(set(g.by_track), {1, 2})
        self.assertEqual(set(g.track_face), {1, 2})
        self.assertEqual(g.by_person, {})
        self.assertEqual(g.recent_unknown, [])

    def test_live_people_are_not_forgotten_early(self):
        g = gate()
        g.should_announce(1, "alice", face(1), 100.0)
        g.forget_absent(live_ids={1}, now=101.0)
        self.assertIn("alice", g.by_person)
        self.assertFalse(g.should_announce(1, "alice", face(1), 102.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class AChangedAnswerIsNews(unittest.TestCase):
    """An identity that settles differently must reach the operator.

    Identities are announced after a few agreeing frames and only settle a
    second or two later. With repeats suppressed and no exception for a CHANGED
    answer, the operator's view froze at the earliest, least certain result: a
    face first called "unknown" and later resolved to a named employee was
    never corrected, and every row on screen read "still settling" forever
    because the settled event was swallowed as a repeat.
    """

    def test_unknown_that_resolves_to_a_name_is_announced(self):
        g = gate()
        person = face(1)
        self.assertTrue(g.should_announce(1, UNKNOWN, person, 0.0))
        self.assertTrue(g.should_announce(1, "alice", person, 2.0))

    def test_a_name_that_turns_out_to_be_someone_else_is_announced(self):
        g = gate()
        self.assertTrue(g.should_announce(1, "alice", face(1), 0.0))
        self.assertTrue(g.should_announce(1, "bob", face(2), 2.0))

    def test_the_same_answer_repeated_is_still_suppressed(self):
        g, alice = gate(), face(1)
        self.assertTrue(g.should_announce(1, "alice", alice, 0.0))
        self.assertFalse(g.should_announce(1, "alice", alice, 2.0))
        self.assertFalse(g.should_announce(1, "alice", alice, 3.0))

    def test_flapping_between_two_answers_does_not_loop_forever(self):
        # A changed answer is allowed through, so the per-person and per-face
        # cooldowns are what stop an oscillating vote from becoming a storm.
        g = gate()
        alice, stranger = face(1), face(2)
        emitted = 0
        for i in range(40):
            who, vec = ("alice", alice) if i % 2 else (UNKNOWN, stranger)
            if g.should_announce(1, who, vec, float(i)):
                emitted += 1
        self.assertLessEqual(emitted, 3, f"{emitted} events from one flapping track")
