"""When a feature is allowed to raise alerts.

WHY THIS EXISTS
    Intrusion on a working yard is the clearest case. Between 07:00 and 19:00
    the restricted area is full of staff doing their jobs, and every one of them
    is an intruder. Given only "on" or "off", a client turns the feature off —
    and the site is then unwatched at night too, which was the whole point.

    So a schedule is not a convenience feature. It is what makes intrusion
    usable on a site where people work.

CONTRACT
    The platform passes FEATURE_SCHEDULES as a JSON object mapping feature name
    to {"days":[0..6], "from":"HH:MM", "to":"HH:MM"}, 0 = Monday. A feature that
    is absent has no schedule and is always on — the behaviour of every
    deployment that predates this.

    This logic is duplicated in shared/analyticsConfig.ts and must stay
    identical. A client told "armed 22:00–06:00" who gets no alert at 23:00 has
    no way to tell which side is wrong, so the two must not drift.
"""
from __future__ import annotations

import json
import os
import time as _time
from datetime import datetime
from zoneinfo import ZoneInfo

#: The site's own timezone — the one a schedule is written in.
#:
#: WHY THIS IS NOT THE SERVER'S CLOCK
#:     The server runs in UTC, as servers should. A client in India who arms
#:     intrusion "19:00-07:00" means 19:00 IST, and reading that against a UTC
#:     clock shifts the whole window by 5h30: the site ends up DISARMED at 20:30
#:     and 23:30 — prime intrusion hours — and ARMED at 09:30 while staff are
#:     working. Exactly inverted, and silently.
#:
#:     So the wall clock a schedule is evaluated against is an explicit setting,
#:     not an accident of where the box is hosted. The platform sends the same
#:     value to the browser, so the "Armed now" badge and the worker cannot
#:     disagree.
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Kolkata")

try:
    _ZONE = ZoneInfo(APP_TIMEZONE)
except Exception as e:  # noqa: BLE001 — unknown zone name, missing tzdata
    print(f"[schedule] APP_TIMEZONE={APP_TIMEZONE!r} is not a timezone ({e}); "
          f"falling back to UTC. Schedules will be read against UTC, which is "
          f"almost certainly not what the site meant.")
    _ZONE = ZoneInfo("UTC")


def _minutes(hhmm: str) -> int:
    h, m = str(hhmm).split(":")
    h, m = int(h), int(m)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError(f"{hhmm!r} is not a time of day")
    return h * 60 + m


class Schedule:
    """One feature's active window. `None` anywhere means always on."""

    __slots__ = ("days", "from_m", "to_m")

    def __init__(self, days, frm: str, to: str):
        self.days = sorted({int(d) for d in days})
        if not self.days or any(d < 0 or d > 6 for d in self.days):
            raise ValueError("schedule days must be 0 (Monday) to 6 (Sunday)")
        self.from_m = _minutes(frm)
        self.to_m = _minutes(to)

    @property
    def all_day(self) -> bool:
        return self.from_m == self.to_m

    @property
    def always(self) -> bool:
        return len(self.days) == 7 and self.all_day

    def active(self, at: float | None = None) -> bool:
        """Is the window open right now?

        A window whose end is not after its start runs THROUGH MIDNIGHT —
        22:00-06:00 is the ordinary intrusion case. The day such a window is
        tested against is the day it STARTED, so a Friday-night watch keeps
        running into Saturday morning rather than stopping at midnight.
        """
        if self.always:
            return True
        # The SITE's wall clock, not the server's.
        now = datetime.fromtimestamp(at if at is not None else _time.time(), _ZONE)
        day = now.weekday()                   # Monday = 0, same as the platform
        mins = now.hour * 60 + now.minute

        if self.all_day:
            return day in self.days
        if self.from_m < self.to_m:
            return day in self.days and self.from_m <= mins < self.to_m
        if mins >= self.from_m:
            return day in self.days
        if mins < self.to_m:
            return (day - 1) % 7 in self.days
        return False

    def describe(self) -> str:
        if self.always:
            return "always on"
        names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        days = "every day" if len(self.days) == 7 else ",".join(names[d] for d in self.days)
        if self.all_day:
            return f"{days}, all day"
        overnight = " (overnight)" if self.from_m >= self.to_m else ""
        return (f"{days}, {self.from_m // 60:02d}:{self.from_m % 60:02d}-"
                f"{self.to_m // 60:02d}:{self.to_m % 60:02d}{overnight}")


def load_schedules(raw: str) -> dict:
    """Parse FEATURE_SCHEDULES. A bad value must never stop the worker.

    Refusing to start over an unreadable schedule would take a whole camera off
    line for a formatting mistake. Falling back to "always on" keeps the site
    monitored, which is the safe direction for a security product, and says so
    loudly enough to be fixed.
    """
    if not raw or not raw.strip():
        return {}
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError) as e:
        print(f"[schedule] FEATURE_SCHEDULES could not be read ({e}); "
              f"every feature will run with no time limit")
        return {}
    out = {}
    for feature, spec in (obj or {}).items():
        try:
            out[feature] = Schedule(spec["days"], spec["from"], spec["to"])
        except Exception as e:  # noqa: BLE001
            print(f"[schedule] '{feature}' schedule is unusable ({e}); "
                  f"running it with no time limit")
    return out


def active(schedules: dict, feature: str, at: float | None = None) -> bool:
    s = schedules.get(feature)
    return True if s is None else s.active(at)
