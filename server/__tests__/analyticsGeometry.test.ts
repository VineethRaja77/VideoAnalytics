// Zones and lines are the only place where a client's own input is handed to a
// Python worker and parsed there. Before this validation existed, a malformed
// polygon raised ValueError inside build_rules, killed the person worker, and
// left the supervisor restarting it forever against a config that could never
// parse — taking every other analytic on that camera down with it.
//
// These tests pin the contract from the browser's side. The Python side has its
// own tests (models/person/tests/test_rules.py) proving the worker survives a
// bad value that gets through anyway.

import { describe, it, expect } from "vitest";
import {
  FEATURE_GEOMETRY,
  formatGeometry,
  parseGeometry,
  validateGeometry,
  validateAnalyticsConfig,
} from "@shared/analyticsConfig";

describe("geometry round-trip", () => {
  it("formats and re-parses a polygon unchanged", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 300 },
    ];
    const spec = formatGeometry(pts);
    expect(spec).toBe("100,100,300,100,300,300");
    expect(parseGeometry(spec)).toEqual(pts);
  });

  it("rounds sub-pixel clicks — a fractional pixel means nothing to the rule", () => {
    expect(formatGeometry([{ x: 10.4, y: 20.6 }])).toBe("10,21");
  });

  it("treats an empty spec as 'not drawn yet', not as an error", () => {
    expect(parseGeometry("")).toEqual([]);
    expect(parseGeometry("   ")).toEqual([]);
    expect(validateGeometry("INTRUSION_ZONE", "")).toBeNull();
  });
});

describe("validateGeometry rejects what would break the worker", () => {
  it("refuses an odd number of coordinates", () => {
    expect(validateGeometry("INTRUSION_ZONE", "100,100,300")).toMatch(/odd number/);
  });

  it("refuses non-numeric coordinates", () => {
    expect(validateGeometry("INTRUSION_ZONE", "a,b,c,d,e,f")).toMatch(/not a number/);
  });

  it("refuses an area with fewer than three corners", () => {
    expect(validateGeometry("INTRUSION_ZONE", "0,0,10,10")).toMatch(/at least 3 corners/);
  });

  it("refuses a line that is not exactly two points", () => {
    expect(validateGeometry("COUNT_LINE", "0,0,10,10,20,20")).toMatch(/exactly 2 points/);
  });

  it("refuses a zero-length line, which nothing can cross", () => {
    expect(validateGeometry("COUNT_LINE", "5,5,5,5")).toMatch(/same point/);
  });

  it("refuses coordinates no camera could produce", () => {
    // The signature of a polygon drawn against a different frame size, whose
    // only symptom otherwise is a zone that silently never fires.
    expect(validateGeometry("INTRUSION_ZONE", "0,0,99999,0,99999,99999")).toMatch(
      /different image size/
    );
  });

  it("refuses negative coordinates", () => {
    expect(validateGeometry("INTRUSION_ZONE", "-5,0,10,0,10,10")).toMatch(
      /different image size/
    );
  });

  it("accepts a well-formed zone and line", () => {
    expect(validateGeometry("INTRUSION_ZONE", "100,100,300,100,300,300,100,300")).toBeNull();
    expect(validateGeometry("COUNT_LINE", "0,240,640,240")).toBeNull();
  });

  it("ignores config keys that are not geometry", () => {
    expect(validateGeometry("LOITER_SECONDS", "not a polygon at all")).toBeNull();
    expect(validateGeometry("CROWD_LIMIT", 12)).toBeNull();
  });

  it("reports every problem in a config, not just the first", () => {
    const problems = validateAnalyticsConfig({
      INTRUSION_ZONE: "1,2,3",
      COUNT_LINE: "9,9,9,9",
      LOITER_SECONDS: 30,
    });
    expect(problems).toHaveLength(2);
  });

  it("treats a null or absent config as valid", () => {
    expect(validateAnalyticsConfig(null)).toEqual([]);
    expect(validateAnalyticsConfig(undefined)).toEqual([]);
  });
});

describe("FEATURE_GEOMETRY matches the worker's own rules", () => {
  it("marks intrusion as REQUIRING a zone", () => {
    // models/person/pipeline/rules.py sets requires_zone = True and raises
    // RuleNotConfigured without one, because a zone rule with no zone treats
    // the whole frame as restricted and alerts on every person in view.
    expect(FEATURE_GEOMETRY.intrusion.required).toBe(true);
    expect(FEATURE_GEOMETRY.intrusion.key).toBe("INTRUSION_ZONE");
  });

  it("does not require geometry for the rules that fall back to the whole frame", () => {
    for (const f of ["loitering", "crowd_density", "queue_dwell", "people_count"]) {
      expect(FEATURE_GEOMETRY[f].required).toBe(false);
    }
  });

  it("gives every entry a key the worker actually reads", () => {
    // A typo here would store config under a key the worker ignores, and the
    // zone would appear saved while doing nothing.
    const workerKeys = new Set([
      "INTRUSION_ZONE", "LOITER_ZONE", "CROWD_ZONE", "QUEUE_ZONE",
      "COUNT_LINE", "TAILGATE_LINE",
    ]);
    for (const g of Object.values(FEATURE_GEOMETRY)) {
      expect(workerKeys.has(g.key)).toBe(true);
    }
  });
});
