"""Tests for the active-window logic.

The overnight case is the reason this exists. A yard is watched 22:00-06:00,
which is not a range in a single day — it starts on one date and ends on the
next. Get it wrong in the obvious way (`from <= now < to`) and the window is
never open at all, so the client's site is unmonitored every night and the
system reports nothing rather than failing loudly.
"""
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from pipeline.schedule import Schedule, load_schedules, active  # noqa: E402

MON, TUE, WED, THU, FRI, SAT, SUN = range(7)


#: Asia/Kolkata — fixed +5:30, no daylight saving.
SITE = timezone(timedelta(hours=5, minutes=30))


def at(day_name: str, hh: int, mm: int = 0) -> float:
    """An instant that reads as this wall clock IN THE SITE'S ZONE.

    Deliberately not time.mktime() on a naive datetime — that builds the time in
    whatever zone the test runner is in, so the suite would pass on a laptop in
    India and fail on a UTC build server while the worker behaved identically on
    both. Pinning the offset makes the test say what it means. 2026-09-07 is a
    Monday.
    """
    day_index = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].index(day_name)
    return datetime(2026, 9, 7 + day_index, hh, mm, tzinfo=SITE).timestamp()


class OvernightWindow(unittest.TestCase):
    """22:00-06:00 — the ordinary intrusion schedule."""

    def setUp(self):
        self.s = Schedule(days=range(7), frm="22:00", to="06:00")

    def test_open_late_at_night(self):
        self.assertTrue(self.s.active(at("mon", 23, 30)))

    def test_open_in_the_small_hours(self):
        self.assertTrue(self.s.active(at("tue", 2, 0)))

    def test_shut_during_the_working_day(self):
        for hour in (7, 9, 12, 15, 18, 21):
            self.assertFalse(self.s.active(at("mon", hour)),
                             f"{hour}:00 should be outside the window")

    def test_opens_exactly_at_the_start(self):
        self.assertTrue(self.s.active(at("mon", 22, 0)))

    def test_closes_exactly_at_the_end(self):
        # 06:00 is the first minute NOT covered; otherwise two adjacent windows
        # would both own it.
        self.assertFalse(self.s.active(at("tue", 6, 0)))
        self.assertTrue(self.s.active(at("tue", 5, 59)))


class OvernightWindowAcrossADayBoundary(unittest.TestCase):
    """A Friday-night watch must keep running into Saturday morning."""

    def setUp(self):
        self.s = Schedule(days=[FRI], frm="22:00", to="06:00")

    def test_friday_night_is_covered(self):
        self.assertTrue(self.s.active(at("fri", 23, 0)))

    def test_saturday_morning_is_still_the_friday_window(self):
        # The decisive case: 02:00 Saturday belongs to the window that OPENED
        # on Friday. Testing it against Saturday's day list would close the
        # watch at midnight, halfway through the night it was set up for.
        self.assertTrue(self.s.active(at("sat", 2, 0)))

    def test_saturday_night_is_not_covered(self):
        self.assertFalse(self.s.active(at("sat", 23, 0)))

    def test_friday_morning_is_not_covered(self):
        # 02:00 Friday belongs to Thursday's window, which is not scheduled.
        self.assertFalse(self.s.active(at("fri", 2, 0)))


class DaytimeWindow(unittest.TestCase):
    def setUp(self):
        self.s = Schedule(days=[MON, TUE, WED, THU, FRI], frm="08:00", to="18:00")

    def test_inside_working_hours_on_a_weekday(self):
        self.assertTrue(self.s.active(at("wed", 12, 0)))

    def test_outside_working_hours_on_a_weekday(self):
        self.assertFalse(self.s.active(at("wed", 7, 0)))
        self.assertFalse(self.s.active(at("wed", 18, 0)))

    def test_not_at_the_weekend(self):
        self.assertFalse(self.s.active(at("sat", 12, 0)))
        self.assertFalse(self.s.active(at("sun", 12, 0)))


class AllDayOnChosenDays(unittest.TestCase):
    """from == to means the whole day, on those days only."""

    def setUp(self):
        self.s = Schedule(days=[SAT, SUN], frm="00:00", to="00:00")

    def test_covers_the_whole_weekend_day(self):
        for hour in (0, 6, 13, 23):
            self.assertTrue(self.s.active(at("sat", hour)))

    def test_covers_nothing_on_a_weekday(self):
        self.assertFalse(self.s.active(at("mon", 13)))

    def test_seven_days_all_day_is_always_on(self):
        s = Schedule(days=range(7), frm="00:00", to="00:00")
        self.assertTrue(s.always)
        self.assertTrue(s.active(at("wed", 3, 17)))


class BadInputNeverStopsTheWorker(unittest.TestCase):
    """A formatting mistake must not take a camera off line."""

    def test_unreadable_json_falls_back_to_always_on(self):
        self.assertEqual(load_schedules("{not json"), {})
        self.assertTrue(active(load_schedules("{not json"), "intrusion"))

    def test_a_broken_entry_only_affects_that_feature(self):
        raw = ('{"intrusion": {"days":[0], "from":"25:00", "to":"06:00"},'
               ' "loitering": {"days":[0,1,2,3,4,5,6], "from":"00:00", "to":"00:00"}}')
        sched = load_schedules(raw)
        self.assertNotIn("intrusion", sched)      # dropped, so it runs unrestricted
        self.assertIn("loitering", sched)
        self.assertTrue(active(sched, "intrusion"))

    def test_an_absent_feature_is_always_on(self):
        sched = load_schedules('{"intrusion": {"days":[0], "from":"22:00", "to":"06:00"}}')
        self.assertTrue(active(sched, "fall"))

    def test_empty_value_means_no_schedules_at_all(self):
        self.assertEqual(load_schedules(""), {})
        self.assertEqual(load_schedules("   "), {})

    def test_days_must_be_valid(self):
        with self.assertRaises(ValueError):
            Schedule(days=[9], frm="00:00", to="01:00")
        with self.assertRaises(ValueError):
            Schedule(days=[], frm="00:00", to="01:00")


class Description(unittest.TestCase):
    def test_reads_like_a_rota(self):
        self.assertEqual(Schedule(range(7), "00:00", "00:00").describe(), "always on")
        self.assertIn("overnight", Schedule(range(7), "22:00", "06:00").describe())
        self.assertIn("Mon", Schedule([MON, WED], "08:00", "18:00").describe())


if __name__ == "__main__":
    unittest.main(verbosity=2)
