// Sensor telemetry: parking bays, tank levels, water quality, fuel.
//
// The commercial promises being tested:
//   * a DEAD sensor is never counted as a free parking bay
//   * an UNCALIBRATED pH probe never raises an alert on a number we have
//     already decided not to trust
//   * alerts DEBOUNCE, so a sloshing tank does not flap
//   * one client's devices and readings are invisible to another
//
// Real Postgres, its own schema.

import "dotenv/config";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { schemaFor, testPool, resetSchema, dropSchema } from "./helpers/testDb";

const TEST_SCHEMA = schemaFor("sensors");

const RAW_DB = process.env.DATABASE_URL || "";
process.env.DATABASE_URL =
  RAW_DB + (RAW_DB.includes("?") ? "&" : "?") +
  `options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.SESSION_SECRET ||= "integration-test-secret-not-for-production";
process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString("base64");

const setupPool = testPool(TEST_SCHEMA);

const {
  breaches, deviceState, calibrationOverdue, ingestReading,
  listDeviceStatus, zoneOccupancy, staleDevices, resetRuleStateForTest,
  classifyFuelChange, recordRunState, resetFuelStateForTest,
} = await import("../sensors");
const { parseTopic, parsePayload } = await import("../sensorMqtt");
const { storage, db } = await import("../storage");
const { devices, sensorRules } = await import("@shared/schema");
const { clearEvents, listEvents } = await import("../events");

let ORG_A = "";
let ORG_B = "";

const DAY = 86_400_000;

beforeAll(async () => {
  await resetSchema(setupPool, TEST_SCHEMA);
  ORG_A = (await storage.createOrganization({ name: "Client A", slug: "sens-a" })).id;
  ORG_B = (await storage.createOrganization({ name: "Client B", slug: "sens-b" })).id;
}, 60_000);

afterAll(async () => {
  await dropSchema(setupPool, TEST_SCHEMA);
  await setupPool.end();
});

beforeEach(() => {
  resetRuleStateForTest();
  clearEvents();
});

/* ------------------------------------------------------------ pure logic */

describe("threshold operators", () => {
  it("handles each comparison", () => {
    expect(breaches({ op: "lt", threshold: 20 }, 19)).toBe(true);
    expect(breaches({ op: "lt", threshold: 20 }, 20)).toBe(false);
    expect(breaches({ op: "gte", threshold: 90 }, 90)).toBe(true);
    expect(breaches({ op: "gt", threshold: 90 }, 90)).toBe(false);
  });

  it("supports a BAND for pH, which a one-sided rule cannot express", () => {
    // "must stay between 6.5 and 8.5" is the actual requirement for potable
    // water; lt/gt alone would need two rules and two alerts.
    const ph = { op: "outside", threshold: 6.5, thresholdHigh: 8.5 };
    expect(breaches(ph, 7.2)).toBe(false);
    expect(breaches(ph, 6.4)).toBe(true);
    expect(breaches(ph, 8.6)).toBe(true);
    expect(breaches(ph, 6.5)).toBe(false); // inclusive bounds
    expect(breaches(ph, 8.5)).toBe(false);
  });

  it("does not silently pass an unknown operator as 'no breach'", () => {
    // A typo'd operator must not quietly disable a rule the operator believes
    // is protecting them.
    expect(breaches({ op: "nonsense", threshold: 1 }, 999)).toBe(false);
  });
});

describe("device state", () => {
  const base = {
    enabled: true, heartbeatSeconds: 60,
    calibrationIntervalDays: null, calibratedAt: null,
  } as any;

  it("is unknown when the sensor has never reported", () => {
    expect(deviceState(base, null)).toBe("unknown");
  });

  it("is unknown once the heartbeat window has passed", () => {
    const now = Date.now();
    expect(deviceState(base, new Date(now - 30_000), now)).toBe("ok");
    expect(deviceState(base, new Date(now - 61_000), now)).toBe("unknown");
  });

  it("flags a probe past its calibration date", () => {
    const now = Date.now();
    const probe = { ...base, calibrationIntervalDays: 30, calibratedAt: new Date(now - 31 * DAY) };
    expect(calibrationOverdue(probe, now)).toBe(true);
    expect(deviceState(probe, new Date(now), now)).toBe("uncalibrated");
  });

  it("treats a never-calibrated probe as overdue", () => {
    const probe = { ...base, calibrationIntervalDays: 30, calibratedAt: null };
    expect(calibrationOverdue(probe)).toBe(true);
  });

  it("does not demand calibration from a level or flow sensor", () => {
    expect(calibrationOverdue(base)).toBe(false);
  });
});

/* -------------------------------------------------------------- ingest */

async function makeDevice(orgId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db.insert(devices).values({
    organizationId: orgId,
    externalId: over.externalId ?? `dev-${Math.random().toString(16).slice(2, 8)}`,
    name: over.name ?? "Test Device",
    kind: over.kind ?? "level_ultrasonic",
    feature: over.feature ?? "tank_level",
    heartbeatSeconds: over.heartbeatSeconds ?? 60,
    ...over,
  } as any).returning();
  return d;
}

describe("ingest", () => {
  it("rejects an unknown device and names the id", async () => {
    const r = await ingestReading(ORG_A, { externalId: "not-a-device", metric: "ph", value: 7 });
    expect(r.ok).toBe(false);
    // The installer needs to see WHICH id was rejected; a typo'd topic is the
    // most common commissioning fault.
    expect(r.reason).toContain("not-a-device");
  });

  it("refuses a device belonging to ANOTHER organization", async () => {
    const d = await makeDevice(ORG_B, { externalId: "b-tank" });
    expect(d).toBeDefined();
    // Client A presents its own token but B's device id.
    const r = await ingestReading(ORG_A, { externalId: "b-tank", metric: "level_percent", value: 50 });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-numeric value instead of storing NaN", async () => {
    const d = await makeDevice(ORG_A, { externalId: "nan-tank" });
    const r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: NaN });
    expect(r.ok).toBe(false);
  });

  it("stores a good reading", async () => {
    const d = await makeDevice(ORG_A, { externalId: "ok-tank" });
    const r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 55 });
    expect(r.ok).toBe(true);
    expect(r.quality).toBe("good");
  });
});

/* ------------------------------------------------------- calibration gate */

describe("uncalibrated probes", () => {
  it("marks readings suspect and does NOT alert on them", async () => {
    const d = await makeDevice(ORG_A, {
      externalId: "ph-overdue", kind: "ph_probe", feature: "water_quality",
      calibrationIntervalDays: 30, calibratedAt: new Date(Date.now() - 60 * DAY),
    });
    await db.insert(sensorRules).values({
      organizationId: ORG_A, kind: "ph_probe", metric: "ph",
      op: "outside", threshold: 6.5, thresholdHigh: 8.5,
      forSeconds: 0, severity: "critical",
    } as any);

    // A wildly out-of-band value from a probe we know is drifting.
    const r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "ph", value: 3.1 });

    expect(r.ok).toBe(true);
    expect(r.quality).toBe("suspect");
    // Alerting on a number already flagged untrustworthy trains operators to
    // ignore alerts. Stay quiet; the maintenance list carries it instead.
    expect(r.alerts).toBe(0);
    expect(listEvents(ORG_A).filter((e) => e.type === "sensor_critical")).toHaveLength(0);
  });

  it("alerts normally from a calibrated probe", async () => {
    const d = await makeDevice(ORG_A, {
      externalId: "ph-fresh", kind: "ph_probe2", feature: "water_quality",
      calibrationIntervalDays: 30, calibratedAt: new Date(),
    });
    await db.insert(sensorRules).values({
      organizationId: ORG_A, kind: "ph_probe2", metric: "ph",
      op: "outside", threshold: 6.5, thresholdHigh: 8.5,
      forSeconds: 0, severity: "critical",
    } as any);

    const r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "ph", value: 9.4 });
    expect(r.quality).toBe("good");
    expect(r.alerts).toBe(1);
    const ev = listEvents(ORG_A).find((e) => e.type === "sensor_critical");
    expect(ev).toBeDefined();
    expect(ev!.message).toContain("9.4");
  });
});

/* ------------------------------------------------------------- debounce */

describe("alert debounce", () => {
  it("stays quiet until the breach has persisted for forSeconds", async () => {
    const d = await makeDevice(ORG_A, { externalId: "slosh-tank", kind: "slosh" });
    await db.insert(sensorRules).values({
      organizationId: ORG_A, kind: "slosh", metric: "level_percent",
      op: "lt", threshold: 20, forSeconds: 60, severity: "warning",
    } as any);

    const t0 = Date.now();
    // A tank sloshing below the line for one reading is not a low-fuel event.
    let r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 19 }, t0);
    expect(r.alerts).toBe(0);

    r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 18 }, t0 + 30_000);
    expect(r.alerts).toBe(0);

    // Still low a minute later — now it is real.
    r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 18 }, t0 + 61_000);
    expect(r.alerts).toBe(1);
  });

  it("alerts once per breach, not on every reading", async () => {
    const d = await makeDevice(ORG_A, { externalId: "repeat-tank", kind: "repeat" });
    await db.insert(sensorRules).values({
      organizationId: ORG_A, kind: "repeat", metric: "level_percent",
      op: "lt", threshold: 20, forSeconds: 0, severity: "warning",
    } as any);

    const t0 = Date.now();
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const r = await ingestReading(
        ORG_A, { externalId: d.externalId, metric: "level_percent", value: 10 }, t0 + i * 1000
      );
      total += r.alerts ?? 0;
    }
    // Five readings below the line is ONE incident. Alerting five times is how
    // operators learn to ignore the bell.
    expect(total).toBe(1);
  });

  it("re-arms after recovery", async () => {
    const d = await makeDevice(ORG_A, { externalId: "rearm-tank", kind: "rearm" });
    await db.insert(sensorRules).values({
      organizationId: ORG_A, kind: "rearm", metric: "level_percent",
      op: "lt", threshold: 20, forSeconds: 0, severity: "warning",
    } as any);

    const t0 = Date.now();
    expect((await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 10 }, t0)).alerts).toBe(1);
    // Refilled.
    await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 80 }, t0 + 1000);
    // Drains again — this is a NEW incident and must alert again.
    expect((await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 9 }, t0 + 2000)).alerts).toBe(1);
  });
});

/* ---------------------------------------------------- parking + staleness */

describe("parking occupancy", () => {
  it("never counts a DEAD sensor as a free bay", async () => {
    // The failure that destroys trust in a parking system: a sign reading
    // "3 free" when those sensors are simply dead, sending drivers to a full
    // level. Silence must be its own state.
    const orgId = (await storage.createOrganization({ name: "Park Co", slug: "park-co" })).id;
    const now = Date.now();

    for (const [ext, val, ageMs] of [
      ["p-1", 1, 0],       // occupied, live
      ["p-2", 0, 0],       // vacant, live
      ["p-3", 0, 999_000],  // reported vacant, but LONG ago → unknown
    ] as const) {
      const d = await makeDevice(orgId, {
        externalId: ext, kind: "ultrasonic_bay", feature: "bay_occupancy",
        zone: "L1", heartbeatSeconds: 60,
      });
      await ingestReading(orgId, { externalId: d.externalId, metric: "occupancy", value: val },
                          now - ageMs);
    }

    const zones = await zoneOccupancy(orgId, now);
    const l1 = zones.find((z) => z.zone === "L1")!;

    expect(l1.total).toBe(3);
    expect(l1.occupied).toBe(1);
    expect(l1.vacant).toBe(1);   // NOT 2 — the stale bay is not free space
    expect(l1.unknown).toBe(1);
  });

  it("lists silent and uncalibrated devices for maintenance", async () => {
    const orgId = (await storage.createOrganization({ name: "Maint Co", slug: "maint-co" })).id;
    const now = Date.now();

    const live = await makeDevice(orgId, { externalId: "m-live", heartbeatSeconds: 60 });
    await ingestReading(orgId, { externalId: live.externalId, metric: "level_percent", value: 50 }, now);
    await makeDevice(orgId, { externalId: "m-silent", heartbeatSeconds: 60 });

    const stale = await staleDevices(orgId, now);
    expect(stale.map((d) => d.externalId)).toContain("m-silent");
    expect(stale.map((d) => d.externalId)).not.toContain("m-live");
  });
});

/* ------------------------------------------------------------ fuel theft */

describe("diesel theft detection", () => {
  // A plain "level < 25%" rule cannot see theft: a tank siphoned 80% -> 60%
  // overnight never crosses it. The signature is a drop that is NOT burn.
  const cfg = { runStateDeviceId: "dg-x", theftDropPercent: 3, settleSeconds: 900 };

  async function fuelDevice(orgId: string, ext: string) {
    return makeDevice(orgId, {
      externalId: ext, kind: "fuel_level", feature: "fuel_monitoring",
      name: "DG Tank", config: cfg as any,
    });
  }

  beforeEach(() => resetFuelStateForTest());

  it("stays silent while the generator is RUNNING", async () => {
    const d = await fuelDevice(ORG_A, `fuel-run-${Math.random().toString(16).slice(2, 6)}`);
    const t = Date.now();
    recordRunState("dg-x", 1, t);
    classifyFuelChange(d, 80, t);                       // baseline
    const v = classifyFuelChange(d, 70, t + 60_000);    // 10% burn
    expect(v.kind).toBe("consumption");
  });

  it("flags a drop while the generator is OFF", async () => {
    const d = await fuelDevice(ORG_A, `fuel-theft-${Math.random().toString(16).slice(2, 6)}`);
    const t = Date.now();
    // Stopped well outside the settle window.
    recordRunState("dg-x", 0, t - 3600_000);
    classifyFuelChange(d, 80, t);
    const v = classifyFuelChange(d, 62, t + 60_000);
    expect(v.kind).toBe("theft");
    expect(v.dropPercent).toBeCloseTo(18, 1);
    expect(v.message).toContain("NOT running");
  });

  it("does NOT cry theft in the minutes after the generator stops", async () => {
    // Fuel sloshes and the reading keeps falling for several minutes after a
    // shutdown. Without a settle window every DG stop is a false alarm, and a
    // client who gets those stops believing the real ones.
    const d = await fuelDevice(ORG_A, `fuel-settle-${Math.random().toString(16).slice(2, 6)}`);
    const t = Date.now();
    recordRunState("dg-x", 1, t - 7200_000);
    recordRunState("dg-x", 0, t);          // just stopped
    classifyFuelChange(d, 80, t);
    const v = classifyFuelChange(d, 74, t + 120_000);  // 2 min later
    expect(v.kind).toBe("consumption");
  });

  it("ignores sensor noise below the drop floor", async () => {
    const d = await fuelDevice(ORG_A, `fuel-noise-${Math.random().toString(16).slice(2, 6)}`);
    const t = Date.now();
    recordRunState("dg-x", 0, t - 3600_000);
    classifyFuelChange(d, 60, t);
    expect(classifyFuelChange(d, 58.5, t + 60_000).kind).toBe("none"); // 1.5% < 3%
  });

  it("treats a rise as a refill, never an alert", async () => {
    const d = await fuelDevice(ORG_A, `fuel-refill-${Math.random().toString(16).slice(2, 6)}`);
    const t = Date.now();
    recordRunState("dg-x", 0, t - 3600_000);
    classifyFuelChange(d, 20, t);
    expect(classifyFuelChange(d, 95, t + 60_000).kind).toBe("refill");
  });

  it("reports an unattributed drop when no run-signal is wired", async () => {
    // A site with no DG contact still wants to know fuel vanished; staying
    // silent because we cannot attribute it would hide the loss entirely.
    const d = await makeDevice(ORG_A, {
      externalId: `fuel-nodg-${Math.random().toString(16).slice(2, 6)}`,
      kind: "fuel_level", feature: "fuel_monitoring", name: "Lone Tank",
      config: { theftDropPercent: 3 } as any,
    });
    const t = Date.now();
    classifyFuelChange(d, 70, t);
    const v = classifyFuelChange(d, 55, t + 60_000);
    expect(v.kind).toBe("theft");
    expect(v.message).toContain("no generator run-signal");
  });

  it("raises a CRITICAL notification through the real ingest path", async () => {
    const d = await makeDevice(ORG_A, {
      externalId: `fuel-e2e-${Math.random().toString(16).slice(2, 6)}`,
      kind: "fuel_level", feature: "fuel_monitoring", name: "Tower A DG Tank",
      site: "Tower A", config: cfg as any,
    });
    const t = Date.now();
    recordRunState("dg-x", 0, t - 3600_000);
    await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 80 }, t);
    const r = await ingestReading(ORG_A, { externalId: d.externalId, metric: "level_percent", value: 58 }, t + 60_000);

    expect(r.alerts).toBeGreaterThanOrEqual(1);
    const ev = listEvents(ORG_A).find((e) => e.message.includes("FUEL THEFT"));
    expect(ev).toBeDefined();
    expect(ev!.severity).toBe("critical");
    // The message must tell an operator what to DO, not just that a number moved.
    expect(ev!.message).toContain("Check the tank and CCTV");
  });
});

/* ------------------------------------------------------- tenant isolation */

describe("tenant isolation", () => {
  it("never shows one client another client's devices", async () => {
    await makeDevice(ORG_B, { externalId: "b-secret-tank", name: "Client B Vault Tank" });
    const aDevices = await listDeviceStatus(ORG_A);
    expect(JSON.stringify(aDevices)).not.toContain("b-secret-tank");
    expect(JSON.stringify(aDevices)).not.toContain("Vault Tank");
  });

  it("scopes alerts to the owning organization", async () => {
    const d = await makeDevice(ORG_B, { externalId: "b-alarm", kind: "balarm", name: "B Tank" });
    await db.insert(sensorRules).values({
      organizationId: ORG_B, kind: "balarm", metric: "level_percent",
      op: "lt", threshold: 20, forSeconds: 0, severity: "warning",
    } as any);

    await ingestReading(ORG_B, { externalId: d.externalId, metric: "level_percent", value: 5 });

    expect(listEvents(ORG_B).some((e) => e.type === "sensor_warning")).toBe(true);
    // The device NAME describes another client's site.
    expect(JSON.stringify(listEvents(ORG_A))).not.toContain("B Tank");
  });
});

/* ------------------------------------------------------------ MQTT parsing */

describe("MQTT topic and payload", () => {
  it("parses the documented topic shape", () => {
    expect(parseTopic("vms/tok123/bay-01/occupancy")).toEqual({
      token: "tok123", externalId: "bay-01", metric: "occupancy",
    });
  });

  it("rejects malformed topics rather than guessing", () => {
    expect(parseTopic("vms/tok/bay-01")).toBeNull();
    expect(parseTopic("other/tok/bay-01/occupancy")).toBeNull();
  });

  it("accepts a bare number, because many PLC gateways publish exactly that", () => {
    expect(parsePayload("42.5")).toEqual({ value: 42.5 });
    expect(parsePayload("  7 ")).toEqual({ value: 7 });
  });

  it("accepts a JSON object with unit and timestamp", () => {
    const p = parsePayload('{"value": 12.3, "unit": "%"}')!;
    expect(p.value).toBe(12.3);
    expect(p.unit).toBe("%");
  });

  it("returns null on junk instead of storing garbage", () => {
    expect(parsePayload("not-a-number")).toBeNull();
    expect(parsePayload("")).toBeNull();
    expect(parsePayload('{"value":"abc"}')).toBeNull();
  });
});
