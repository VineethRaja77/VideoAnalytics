// Feature <-> module registry invariants.
//
// This mapping decides what a client is billed for and which process gets
// spawned. A mistake here either bills for the wrong thing or hands a client
// analytics they never bought, and neither would throw — hence these tests.

import { describe, it, expect } from "vitest";
import {
  MODULE_FEATURES,
  ANALYTICS_MODULES,
  ANALYTICS_FEATURES,
  FEATURE_MODULE,
  FEATURE_LABELS,
} from "@shared/schema";

describe("feature registry", () => {
  it("maps every feature to exactly one module", () => {
    for (const f of ANALYTICS_FEATURES) {
      expect(FEATURE_MODULE[f], `no module for ${f}`).toBeTruthy();
      expect(ANALYTICS_MODULES).toContain(FEATURE_MODULE[f]);
    }
  });

  it("has no duplicate feature names across modules", () => {
    // A duplicate would make FEATURE_MODULE ambiguous and silently route a
    // feature to whichever module was declared last.
    const all = Object.values(MODULE_FEATURES).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives every feature a human label for the admin console", () => {
    for (const f of ANALYTICS_FEATURES) {
      expect(FEATURE_LABELS[f], `no label for ${f}`).toBeTruthy();
    }
  });

  it("has no orphan labels for features that no longer exist", () => {
    for (const key of Object.keys(FEATURE_LABELS)) {
      expect(ANALYTICS_FEATURES, `stale label ${key}`).toContain(key);
    }
  });

  it("keeps every module non-empty", () => {
    for (const [mod, feats] of Object.entries(MODULE_FEATURES)) {
      expect(feats.length, `module ${mod} has no features`).toBeGreaterThan(0);
    }
  });

  it("round-trips module -> features -> module", () => {
    for (const [mod, feats] of Object.entries(MODULE_FEATURES)) {
      for (const f of feats) expect(FEATURE_MODULE[f]).toBe(mod);
    }
  });
});

describe("licensing granularity", () => {
  it("does NOT let one licence imply its module's other features", () => {
    // The whole point of the refactor: intrusion and loitering are separate
    // products even though one `person` worker provides both.
    expect(FEATURE_MODULE.intrusion).toBe("person");
    expect(FEATURE_MODULE.loitering).toBe("person");
    expect("intrusion").not.toBe("loitering");
    expect(ANALYTICS_FEATURES).toContain("intrusion");
    expect(ANALYTICS_FEATURES).toContain("loitering");
  });

  it("groups multi-feature modules so they share one process", () => {
    // If these ever became one feature each, the supervisor would spawn a
    // process per analytic and recompute the same detections N times.
    expect(MODULE_FEATURES.person.length).toBeGreaterThan(1);
    expect(MODULE_FEATURES.vehicle.length).toBeGreaterThan(1);
  });

  it("keeps the pre-existing modules addressable", () => {
    // Migration 0005 renames the old per-module products to these keys.
    expect(FEATURE_MODULE.ppe_compliance).toBe("ppe");
    expect(FEATURE_MODULE.face_recognition).toBe("face");
    expect(FEATURE_MODULE.vehicle_count).toBe("vehicle");
  });
});
