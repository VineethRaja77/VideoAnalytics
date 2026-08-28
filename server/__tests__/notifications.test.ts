// Operational notifications must not leak across tenants.
//
// The notification bell carries recorder/worker crash messages that embed the
// CAMERA NAME. Served unscoped, one client sees the names and ids of another
// client's cameras plus their infrastructure health — a direct disclosure of a
// competitor's site layout, with no obvious symptom.

import "dotenv/config";

import { describe, it, expect, beforeEach } from "vitest";
import { emitEvent, listEvents, clearEvents } from "../events";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

const camA = { id: "cam-a1", name: "Client A — Gate 3 Loading Bay", organizationId: ORG_A };
const camB = { id: "cam-b1", name: "Client B — Vault Corridor", organizationId: ORG_B };

beforeEach(() => clearEvents());

describe("notification scoping", () => {
  it("gives each org only its own events", () => {
    emitEvent("recorder_crashed", "Recording for A stopped", camA);
    emitEvent("recorder_crashed", "Recording for B stopped", camB);

    const a = listEvents(ORG_A);
    const b = listEvents(ORG_B);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].cameraId).toBe("cam-a1");
    expect(b[0].cameraId).toBe("cam-b1");
  });

  it("never exposes another client's camera NAME", () => {
    // The camera name is the actual disclosure: it describes a site.
    emitEvent("recorder_crashed", "Recording for B stopped", camB);
    const a = listEvents(ORG_A);
    expect(JSON.stringify(a)).not.toContain("Vault Corridor");
    expect(JSON.stringify(a)).not.toContain("cam-b1");
  });

  it("never exposes another client's camera name inside the MESSAGE", () => {
    // The message string is built from the camera name, so scoping the
    // cameraId field alone would still leak it in prose.
    emitEvent("analytics_worker_crashed",
      'vehicle worker for "Client B — Vault Corridor" crashed (code=1)', camB);
    expect(JSON.stringify(listEvents(ORG_A))).not.toContain("Vault Corridor");
  });

  it("shows platform-wide events (no camera) to everyone", () => {
    // Events with no camera are platform notices, not tenant data.
    emitEvent("recorder_started", "Platform started");
    expect(listEvents(ORG_A)).toHaveLength(1);
    expect(listEvents(ORG_B)).toHaveLength(1);
  });

  it("lets super_admin see everything", () => {
    emitEvent("recorder_crashed", "A", camA);
    emitEvent("recorder_crashed", "B", camB);
    expect(listEvents(null, true)).toHaveLength(2);
  });

  it("returns nothing when no org can be resolved", () => {
    // A client role with no org must get an empty list, never the global one.
    emitEvent("recorder_crashed", "A", camA);
    expect(listEvents(null, false)).toHaveLength(0);
  });

  it("keeps the in-memory log bounded", () => {
    for (let i = 0; i < 2000; i++) emitEvent("recorder_started", `e${i}`, camA);
    expect(listEvents(ORG_A).length).toBeLessThanOrEqual(500);
  });

  it("a noisy tenant pushes out an older tenant's events, not the reverse", () => {
    // Known trade-off of one shared ring buffer: a tenant with many cameras
    // can evict another tenant's older notices. Acceptable because this is a
    // recent-activity surface, not an audit trail — analytics_events is the
    // durable record. Pinned so the behaviour is deliberate, not a surprise.
    emitEvent("recorder_crashed", "B first", camB);
    for (let i = 0; i < 600; i++) emitEvent("recorder_started", `A${i}`, camA);
    expect(listEvents(ORG_B)).toHaveLength(0);
    expect(listEvents(ORG_A).length).toBeGreaterThan(0);
  });

  it("tags severity so an operator can triage", () => {
    emitEvent("storage_critical", "disk full", camA);
    emitEvent("recorder_started", "ok", camA);
    const all = listEvents(ORG_A);
    expect(all.find((e) => e.type === "storage_critical")!.severity).toBe("critical");
    expect(all.find((e) => e.type === "recorder_started")!.severity).toBe("info");
  });
});
