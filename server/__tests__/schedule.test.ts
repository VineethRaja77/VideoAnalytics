// The active-window logic, and the promise that it matches the workers'.
//
// This logic exists twice — here and in models/*/pipeline/schedule.py — because
// the browser must be able to show "armed now" without asking a Python worker,
// and the worker must decide without asking the platform. Two copies can drift,
// and the failure is nasty: the client is told intrusion is armed, gets no
// alert, and has no way to tell which half is wrong.
//
// So the cases below are the SAME cases as models/person/tests/test_schedule.py,
// deliberately mirrored. If one side changes, one of the two suites fails.

import { describe, it, expect } from "vitest";
import {
  ALWAYS,
  describeSchedule,
  formatSchedule,
  isAlwaysOn,
  isScheduleActive,
  parseSchedule,
  validateSchedule,
  type Schedule,
} from "@shared/analyticsConfig";

const MON = 0, TUE = 1, WED = 2, THU = 3, FRI = 4, SAT = 5, SUN = 6;

/**
 * An instant that reads as this wall clock IN THE SITE'S ZONE.
 *
 * Deliberately not `new Date(y, m, d, hh)` — that builds the time in whatever
 * zone the test runner happens to be in, so the suite would pass on a laptop in
 * India and fail on a UTC build server while the product behaved identically on
 * both. Pinning the offset makes the test say what it means: "23:30 at the
 * site". 2026-09-07 is a Monday.
 */
const SITE_OFFSET = "+05:30"; // Asia/Kolkata — fixed, no daylight saving
function at(day: "mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun", hh: number, mm = 0): Date {
  const idx = ["mon","tue","wed","thu","fri","sat","sun"].indexOf(day);
  const dd = String(7 + idx).padStart(2, "0");
  const HH = String(hh).padStart(2, "0");
  const MM = String(mm).padStart(2, "0");
  return new Date(`2026-09-${dd}T${HH}:${MM}:00${SITE_OFFSET}`);
}

const sched = (days: number[], from: string, to: string): Schedule => ({ days, from, to });

describe("overnight window (the ordinary intrusion schedule)", () => {
  const s = sched([0,1,2,3,4,5,6], "22:00", "06:00");

  it("is open late at night", () => expect(isScheduleActive(s, at("mon", 23, 30))).toBe(true));
  it("is open in the small hours", () => expect(isScheduleActive(s, at("tue", 2))).toBe(true));

  it("is shut through the working day", () => {
    for (const h of [7, 9, 12, 15, 18, 21]) {
      expect(isScheduleActive(s, at("mon", h)), `${h}:00`).toBe(false);
    }
  });

  it("opens exactly at the start and closes exactly at the end", () => {
    expect(isScheduleActive(s, at("mon", 22, 0))).toBe(true);
    expect(isScheduleActive(s, at("tue", 5, 59))).toBe(true);
    expect(isScheduleActive(s, at("tue", 6, 0))).toBe(false);
  });
});

describe("an overnight window belongs to the day it STARTED", () => {
  const friNight = sched([FRI], "22:00", "06:00");

  it("covers Friday night", () => expect(isScheduleActive(friNight, at("fri", 23))).toBe(true));

  it("still covers Saturday at 02:00", () => {
    // The decisive case. Testing 02:00 Saturday against Saturday's day list
    // would close the watch at midnight, halfway through the night it was set
    // up for.
    expect(isScheduleActive(friNight, at("sat", 2))).toBe(true);
  });

  it("does not cover Saturday night", () =>
    expect(isScheduleActive(friNight, at("sat", 23))).toBe(false));

  it("does not cover Friday morning", () =>
    expect(isScheduleActive(friNight, at("fri", 2))).toBe(false));
});

describe("daytime window", () => {
  const s = sched([MON, TUE, WED, THU, FRI], "08:00", "18:00");
  it("is open inside working hours", () => expect(isScheduleActive(s, at("wed", 12))).toBe(true));
  it("is shut outside them", () => {
    expect(isScheduleActive(s, at("wed", 7))).toBe(false);
    expect(isScheduleActive(s, at("wed", 18))).toBe(false);
  });
  it("is shut at the weekend", () => {
    expect(isScheduleActive(s, at("sat", 12))).toBe(false);
    expect(isScheduleActive(s, at("sun", 12))).toBe(false);
  });
});

describe("all day on chosen days", () => {
  const s = sched([SAT, SUN], "00:00", "00:00");
  it("covers the whole weekend day", () => {
    for (const h of [0, 6, 13, 23]) expect(isScheduleActive(s, at("sat", h))).toBe(true);
  });
  it("covers nothing on a weekday", () =>
    expect(isScheduleActive(s, at("mon", 13))).toBe(false));
  it("seven days all day is 'always on'", () => {
    expect(isAlwaysOn(ALWAYS)).toBe(true);
    expect(isScheduleActive(ALWAYS, at("wed", 3, 17))).toBe(true);
  });
});

describe("no schedule at all", () => {
  it("is always on", () => {
    expect(isScheduleActive(null, at("wed", 3))).toBe(true);
    expect(isScheduleActive(undefined, at("wed", 3))).toBe(true);
  });
});

describe("parsing and validation", () => {
  it("round-trips through the stored string", () => {
    const s = sched([MON, FRI], "22:00", "06:00");
    expect(parseSchedule(formatSchedule(s))).toEqual(s);
  });
  it("treats an empty value as no schedule", () => {
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule(null)).toBeNull();
  });
  it("rejects an impossible time", () =>
    expect(validateSchedule({ days: [0], from: "25:00", to: "06:00" })).toMatch(/time of day/));
  it("rejects an empty day list", () =>
    expect(validateSchedule({ days: [], from: "00:00", to: "06:00" })).toMatch(/at least one day/));
  it("rejects a day outside the week", () =>
    expect(validateSchedule({ days: [9], from: "00:00", to: "06:00" })).toMatch(/Monday/));
  it("accepts a well-formed schedule", () =>
    expect(validateSchedule({ days: [0, 1], from: "22:00", to: "06:00" })).toBeNull());
  it("de-duplicates and sorts the days", () =>
    expect(parseSchedule({ days: [3, 1, 1, 0], from: "00:00", to: "00:00" })!.days)
      .toEqual([0, 1, 3]));
});

describe("what the operator reads", () => {
  it("says 'Always on' when there is no limit", () =>
    expect(describeSchedule(ALWAYS)).toBe("Always on"));
  it("flags an overnight window, because that is the confusing one", () =>
    expect(describeSchedule(sched([0,1,2,3,4,5,6], "22:00", "06:00"))).toContain("overnight"));
  it("collapses the working week", () =>
    expect(describeSchedule(sched([MON,TUE,WED,THU,FRI], "08:00", "18:00"))).toContain("Mon–Fri"));
  it("collapses the weekend", () =>
    expect(describeSchedule(sched([SAT,SUN], "00:00", "00:00"))).toContain("Weekends"));
});
