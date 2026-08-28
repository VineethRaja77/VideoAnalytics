// server/sensors.ts
//
// Physical-sensor telemetry: parking bays, tank levels, water quality, fuel,
// energy meters, pump/DG status.
//
// This is NOT a video module. There is no camera, no RTSP, no GPU and no model.
// A reading arrives every 30-60s per device, is stored, and is evaluated
// against threshold rules. It lives inside the main server rather than a
// per-device worker because the whole workload is a few hundred rows a minute.
//
// Three rules govern the design, all learned from the camera side of this
// product:
//
//   1. SILENCE IS ITS OWN STATE. A sensor that stops reporting is `unknown`,
//      never "vacant" and never "full". A dead bay sensor read as vacant sends
//      drivers to a full level; a dead tank sensor read as full hides an empty
//      tank. Fail closed, exactly like resolveOrgScope.
//
//   2. AN UNCALIBRATED PROBE IS NOT TRUSTED. pH electrodes drift and then
//      report confidently wrong numbers. Past its calibration interval a
//      reading is stored but marked `suspect`, and rules do not fire on it.
//
//   3. ALERTS DEBOUNCE. A tank sloshing across a threshold for one reading is
//      not a low-fuel event. Rules carry `forSeconds`; without it operators get
//      flapping alerts and stop reading them.

import { db } from "./storage";
import { devices, sensorReadings, sensorRules, type Device } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { emitEvent } from "./events";

export type DeviceState = "ok" | "unknown" | "uncalibrated" | "disabled";
export type Quality = "good" | "suspect" | "stale";

/* ------------------------------------------------------------ calibration */

/** Is this device past its calibration due date? */
export function calibrationOverdue(d: Device, now = Date.now()): boolean {
  if (!d.calibrationIntervalDays) return false; // nothing to calibrate
  if (!d.calibratedAt) return true;             // never calibrated = overdue
  const dueMs = d.calibrationIntervalDays * 86_400_000;
  return now - new Date(d.calibratedAt).getTime() > dueMs;
}

/**
 * Live state of a device given the timestamp of its most recent reading.
 *
 * `lastAt` null or older than heartbeat => "unknown". The caller must treat
 * unknown as unknown: never fold it into a free-space count or a tank total.
 */
export function deviceState(
  d: Device,
  lastAt: Date | null,
  now = Date.now()
): DeviceState {
  if (!d.enabled) return "disabled";
  if (!lastAt) return "unknown";
  if (now - new Date(lastAt).getTime() > d.heartbeatSeconds * 1000) return "unknown";
  if (calibrationOverdue(d, now)) return "uncalibrated";
  return "ok";
}

/* ------------------------------------------------------------- rule logic */

export interface RuleLike {
  op: string;
  threshold: number;
  thresholdHigh?: number | null;
}

/** Does a value breach this rule? Pure, so it is cheap to test exhaustively. */
export function breaches(rule: RuleLike, value: number): boolean {
  switch (rule.op) {
    case "lt":  return value < rule.threshold;
    case "lte": return value <= rule.threshold;
    case "gt":  return value > rule.threshold;
    case "gte": return value >= rule.threshold;
    case "eq":  return value === rule.threshold;
    // `outside` is the band check that pH and temperature need: alert when the
    // value leaves [threshold, thresholdHigh]. A single-sided rule cannot
    // express "must stay between 6.5 and 8.5".
    case "outside": {
      const hi = rule.thresholdHigh;
      if (hi === null || hi === undefined) return false;
      return value < rule.threshold || value > hi;
    }
    default:
      // An unknown operator must not silently pass as "no breach" — that would
      // disable a rule the operator believes is protecting them.
      console.error(`❌ sensor rule has unknown operator "${rule.op}" — rule ignored`);
      return false;
  }
}

/** In-memory breach tracking, for the `forSeconds` debounce. */
const breachSince = new Map<string, number>();   // ruleId:deviceId -> epoch ms
const alerted = new Set<string>();               // ruleId:deviceId already alerted

function breachKey(ruleId: string, deviceId: string): string {
  return `${ruleId}:${deviceId}`;
}

/** Test helper — the maps are process-local state. */
export function resetRuleStateForTest(): void {
  breachSince.clear();
  alerted.clear();
}

/* ---------------------------------------------------------------- ingest */

export interface ReadingInput {
  externalId: string;
  metric: string;
  value: number;
  unit?: string | null;
  at?: Date;
}

export interface IngestResult {
  ok: boolean;
  reason?: string;
  deviceId?: string;
  quality?: Quality;
  alerts?: number;
}

/**
 * Store one reading and evaluate rules for it.
 *
 * `organizationId` comes from the authenticated ingest token, NOT from the
 * payload — the same rule as the analytics ingest path. A gateway holding one
 * site's token can never write readings for another tenant, even if it knows
 * the other tenant's device id.
 */
export async function ingestReading(
  organizationId: string,
  input: ReadingInput,
  now = Date.now()
): Promise<IngestResult> {
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.organizationId, organizationId), eq(devices.externalId, input.externalId)));

  const device = rows[0];
  if (!device) {
    // Named explicitly: "unknown device" with no id is the single most common
    // commissioning error (typo in the gateway topic) and the message has to
    // say which id was rejected or the installer cannot find it.
    return { ok: false, reason: `Unknown device "${input.externalId}" for this organization` };
  }
  if (!device.enabled) {
    return { ok: false, reason: `Device "${input.externalId}" is disabled`, deviceId: device.id };
  }

  if (!Number.isFinite(input.value)) {
    return { ok: false, reason: `Non-numeric value for ${input.metric}`, deviceId: device.id };
  }

  const quality: Quality = calibrationOverdue(device, now) ? "suspect" : "good";

  await db.insert(sensorReadings).values({
    organizationId,
    deviceId: device.id,
    metric: input.metric,
    value: input.value,
    unit: input.unit ?? null,
    quality,
    at: input.at ?? new Date(now),
  });

  let alerts = await evaluateRules(device, input.metric, input.value, quality, now);

  // Track generator on/off so fuel drops can be attributed to burn vs theft.
  if (input.metric === "state") {
    recordRunState(device.externalId, input.value, now);
  }

  // Fuel theft is a CROSS-DEVICE correlation, so it runs outside the generic
  // threshold rules — see classifyFuelChange.
  if (device.feature === "fuel_monitoring" && input.metric === "level_percent" && quality === "good") {
    const verdict = classifyFuelChange(device, input.value, now);
    if (verdict.kind === "theft") {
      alerts++;
      emitEvent(
        "sensor_critical",
        `POSSIBLE FUEL THEFT — ${device.name} (${device.site ?? "site"}) ` +
          `${verdict.message}. Level now ${input.value}%. Check the tank and CCTV for this period.`,
        undefined,
        device.organizationId
      );
    }
  }

  return { ok: true, deviceId: device.id, quality, alerts };
}

/**
 * Evaluate every rule matching this device+metric.
 *
 * A `suspect` reading (uncalibrated probe) never fires a rule. Alerting on a
 * number you have already decided not to trust is worse than staying quiet: it
 * trains the operator to ignore the alert.
 */
async function evaluateRules(
  device: Device,
  metric: string,
  value: number,
  quality: Quality,
  now: number
): Promise<number> {
  if (quality !== "good") return 0;

  const rules = await db
    .select()
    .from(sensorRules)
    .where(and(eq(sensorRules.organizationId, device.organizationId), eq(sensorRules.enabled, true)));

  let fired = 0;
  for (const rule of rules) {
    if (rule.metric !== metric) continue;
    // A rule targets one device, or every device of a kind. Neither set = skip
    // rather than apply to everything, which would be a surprising default.
    if (rule.deviceId) {
      if (rule.deviceId !== device.id) continue;
    } else if (rule.kind) {
      if (rule.kind !== device.kind) continue;
    } else {
      continue;
    }

    const key = breachKey(rule.id, device.id);
    if (!breaches(rule, value)) {
      // Recovered: clear state so the next breach alerts again.
      if (alerted.has(key)) {
        emitEvent(
          "sensor_recovered",
          `${device.name}: ${metric} back to normal (${value}).`,
          undefined,
          device.organizationId
        );
      }
      breachSince.delete(key);
      alerted.delete(key);
      continue;
    }

    const since = breachSince.get(key) ?? now;
    breachSince.set(key, since);

    // Debounce window not yet satisfied — keep watching, stay quiet.
    if (now - since < rule.forSeconds * 1000) continue;
    if (alerted.has(key)) continue; // already told them; do not repeat

    alerted.add(key);
    fired++;

    const detail =
      rule.op === "outside"
        ? `${value} is outside ${rule.threshold}–${rule.thresholdHigh}`
        : `${value} ${rule.op} ${rule.threshold}`;

    emitEvent(
      rule.severity === "critical" ? "sensor_critical" : "sensor_warning",
      rule.message
        ? `${device.name}: ${rule.message} (${detail})`
        : `${device.name} (${device.site ?? "site"}): ${metric} ${detail}`,
      undefined,
      device.organizationId
    );
  }
  return fired;
}

/* ------------------------------------------------------- fuel theft rule */

/**
 * Diesel theft detection.
 *
 * A plain "level < 25%" threshold cannot see theft — a tank siphoned from 80%
 * to 60% overnight never crosses it, and the client discovers the loss on the
 * fuel bill. The signature is a DROP THAT IS NOT CONSUMPTION:
 *
 *     level falling + generator RUNNING  -> normal burn, stay quiet
 *     level falling + generator OFF      -> THEFT
 *     level rising                       -> refill, record but never alert
 *
 * This needs two devices correlated, so it cannot be expressed in the generic
 * `sensor_rules` table (one metric, one threshold). It lives here instead.
 *
 * Configured per fuel device in `devices.config`:
 *   {
 *     "runStateDeviceId": "dg-1",   // external id of the DG run-state device
 *     "theftDropPercent": 3,        // minimum drop to consider (noise floor)
 *     "settleSeconds": 900          // ignore drops this soon after the DG stops
 *   }
 *
 * `settleSeconds` matters in the field: fuel sloshes and the float/ultrasonic
 * reading keeps falling for several minutes after a generator stops. Without
 * it every DG shutdown raises a false theft alert, and the client stops
 * believing the alerts — which is worse than not having the feature.
 */
export interface FuelConfig {
  runStateDeviceId?: string;
  theftDropPercent?: number;
  settleSeconds?: number;
}

interface FuelState {
  level: number;
  at: number;
}
const fuelLast = new Map<string, FuelState>();       // deviceId -> last level
const runLast = new Map<string, { running: boolean; changedAt: number }>();

export function resetFuelStateForTest(): void {
  fuelLast.clear();
  runLast.clear();
}

/** Record a run-state reading (DG on/off) so fuel drops can be attributed. */
export function recordRunState(deviceExternalId: string, value: number, now = Date.now()): void {
  const running = value >= 0.5;
  const prev = runLast.get(deviceExternalId);
  // changedAt only moves on an actual transition — the settle window is
  // measured from when the DG STOPPED, not from the last heartbeat.
  if (!prev || prev.running !== running) {
    runLast.set(deviceExternalId, { running, changedAt: now });
  }
}

export interface FuelVerdict {
  kind: "theft" | "consumption" | "refill" | "none";
  dropPercent?: number;
  message?: string;
}

/**
 * Classify a new fuel level against the previous one and the generator state.
 * Pure apart from the two module-level maps, so it is directly testable.
 */
export function classifyFuelChange(
  device: Device,
  value: number,
  now = Date.now()
): FuelVerdict {
  const cfg = (device.config ?? {}) as FuelConfig;
  const minDrop = cfg.theftDropPercent ?? 3;
  const settleMs = (cfg.settleSeconds ?? 900) * 1000;

  const prev = fuelLast.get(device.id);
  fuelLast.set(device.id, { level: value, at: now });

  if (!prev) return { kind: "none" };            // first reading, no baseline

  const delta = value - prev.level;
  if (delta > 1) return { kind: "refill", dropPercent: -delta };
  if (delta > -minDrop) return { kind: "none" }; // within noise

  const drop = -delta;

  // No run-state device configured: every meaningful drop is unattributed, so
  // report it rather than stay silent. A site with no DG signal still wants to
  // know fuel vanished.
  const runId = cfg.runStateDeviceId;
  if (!runId) {
    return {
      kind: "theft",
      dropPercent: drop,
      message: `dropped ${drop.toFixed(1)}% with no generator run-signal configured`,
    };
  }

  const run = runLast.get(runId);
  if (run?.running) return { kind: "consumption", dropPercent: drop };

  // Recently stopped: fuel is still settling, not being stolen.
  if (run && now - run.changedAt < settleMs) {
    return { kind: "consumption", dropPercent: drop };
  }

  return {
    kind: "theft",
    dropPercent: drop,
    message: `dropped ${drop.toFixed(1)}% while the generator was NOT running`,
  };
}

/* --------------------------------------------------------------- queries */

export interface DeviceStatus {
  id: string;
  externalId: string;
  name: string;
  kind: string;
  feature: string;
  site: string | null;
  zone: string | null;
  state: DeviceState;
  lastValue: number | null;
  lastMetric: string | null;
  lastAt: Date | null;
  calibrationOverdue: boolean;
}

/**
 * Current status of every device in an org.
 *
 * One query for devices plus one for latest readings — not N+1, because a
 * 500-bay garage would otherwise issue 500 queries per dashboard refresh.
 */
export async function listDeviceStatus(
  organizationId: string,
  now = Date.now()
): Promise<DeviceStatus[]> {
  const devs = await db.select().from(devices).where(eq(devices.organizationId, organizationId));
  if (!devs.length) return [];

  // DISTINCT ON gives the newest row per device in a single pass.
  const latest = (await db.execute(sql`
    SELECT DISTINCT ON (device_id) device_id, metric, value, at
    FROM sensor_readings
    WHERE organization_id = ${organizationId}
    ORDER BY device_id, at DESC
  `)) as unknown as {
    rows: Array<{ device_id: string; metric: string; value: number; at: Date }>;
  };

  const byDevice = new Map((latest.rows ?? []).map((r) => [r.device_id, r]));

  return devs.map((d) => {
    const last = byDevice.get(d.id);
    const lastAt = last ? new Date(last.at) : null;
    return {
      id: d.id,
      externalId: d.externalId,
      name: d.name,
      kind: d.kind,
      feature: d.feature,
      site: d.site,
      zone: d.zone,
      state: deviceState(d, lastAt, now),
      lastValue: last ? Number(last.value) : null,
      lastMetric: last?.metric ?? null,
      lastAt,
      calibrationOverdue: calibrationOverdue(d, now),
    };
  });
}

export interface ZoneOccupancy {
  zone: string;
  total: number;
  occupied: number;
  vacant: number;
  unknown: number;
}

/**
 * Parking occupancy per zone.
 *
 * `vacant` counts ONLY bays confirmed vacant by a live sensor. Bays whose
 * sensor is silent are reported separately as `unknown` and are never added to
 * the free count — a sign reading "12 free" when four sensors are dead sends
 * drivers to a full level, which is the failure that destroys trust in the
 * whole system.
 */
export async function zoneOccupancy(
  organizationId: string,
  now = Date.now()
): Promise<ZoneOccupancy[]> {
  const all = await listDeviceStatus(organizationId, now);
  const bays = all.filter((d) => d.feature === "bay_occupancy");

  const byZone = new Map<string, ZoneOccupancy>();
  for (const b of bays) {
    const zone = b.zone ?? "unzoned";
    const z = byZone.get(zone) ?? { zone, total: 0, occupied: 0, vacant: 0, unknown: 0 };
    z.total++;
    if (b.state !== "ok" || b.lastValue === null) z.unknown++;
    else if (b.lastValue >= 0.5) z.occupied++;
    else z.vacant++;
    byZone.set(zone, z);
  }
  return [...byZone.values()].sort((a, b) => a.zone.localeCompare(b.zone));
}

/**
 * Devices that have gone silent, for the maintenance view.
 *
 * Emitting one platform notice per dead sensor would flood the bell on a site
 * with hundreds of devices, so this is a pull-based list; the caller decides
 * how to summarise it.
 */
export async function staleDevices(organizationId: string, now = Date.now()) {
  return (await listDeviceStatus(organizationId, now)).filter(
    (d) => d.state === "unknown" || d.state === "uncalibrated"
  );
}

/** Recent readings for one device — the chart behind a tile. */
export async function deviceHistory(
  organizationId: string,
  deviceId: string,
  sinceMs = 24 * 3600_000,
  limit = 500
) {
  return db
    .select()
    .from(sensorReadings)
    .where(
      and(
        eq(sensorReadings.organizationId, organizationId),
        eq(sensorReadings.deviceId, deviceId),
        gte(sensorReadings.at, new Date(Date.now() - sinceMs))
      )
    )
    .orderBy(desc(sensorReadings.at))
    .limit(Math.min(Math.max(limit, 1), 5000));
}
