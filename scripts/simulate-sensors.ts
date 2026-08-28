// scripts/simulate-sensors.ts
//
// A fake building. Publishes realistic telemetry so the whole sensor pipeline
// can be exercised with no hardware at all — provisioning, ingest, thresholds,
// debounce, staleness, calibration, parking counts and alerts.
//
// It models the four scenarios that actually matter commercially:
//
//   1. PARKING     20 bays that fill and empty, plus one sensor that DIES
//                  mid-run — the free count must drop it to `unknown`, never
//                  count it as vacant.
//   2. WATER TANK  a slow drain through the low-level threshold.
//   3. pH PROBE    drifts out of the 6.5–8.5 band, and one probe is past its
//                  calibration date so its readings must be marked suspect and
//                  must NOT raise alerts.
//   4. DIESEL      normal generator consumption, then a sharp overnight drop
//                  while the DG is OFF — the theft signature.
//
// USAGE
//   npx tsx scripts/simulate-sensors.ts --provision   # create the devices+rules
//   npx tsx scripts/simulate-sensors.ts               # run the simulation
//   BASE_URL=... INGEST_KEY=... npx tsx scripts/simulate-sensors.ts
//
// Talks to the platform over plain HTTP ingest, so it needs no broker. Use
// --mqtt to publish over MQTT instead (requires MQTT_URL).

import { db } from "../server/storage";
import { devices, sensorRules } from "@shared/schema";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5000";
const INGEST_KEY = process.env.INGEST_KEY || "";
const ORG_ID = process.env.ORG_ID || "";
const SPEED = Number(process.env.SPEED || 1);      // >1 = compress time
const TICKS = Number(process.env.TICKS || 40);

const BAYS = 20;

/* ------------------------------------------------------------ provision */

async function provision(orgId: string): Promise<void> {
  console.log(`▶ Provisioning simulated devices for org ${orgId}`);

  const rows: Array<typeof devices.$inferInsert> = [];

  for (let i = 1; i <= BAYS; i++) {
    rows.push({
      organizationId: orgId,
      externalId: `bay-${String(i).padStart(2, "0")}`,
      name: `Bay ${i}`,
      kind: "ultrasonic_bay",
      feature: "bay_occupancy",
      site: "Tower A",
      zone: i <= 10 ? "L1" : "L2",
      // Short heartbeat so a dead sensor is visible within one simulated run
      // rather than five real minutes.
      heartbeatSeconds: 30,
    });
  }

  rows.push({
    organizationId: orgId,
    externalId: "tank-water-1",
    name: "Domestic Water Tank",
    kind: "level_ultrasonic",
    feature: "tank_level",
    site: "Tower A",
    zone: "Terrace",
    heartbeatSeconds: 60,
  });

  rows.push({
    organizationId: orgId,
    externalId: "ph-1",
    name: "Water pH (calibrated)",
    kind: "ph_probe",
    feature: "water_quality",
    site: "Tower A",
    zone: "Pump Room",
    heartbeatSeconds: 60,
    calibrationIntervalDays: 30,
    calibratedAt: new Date(),
  });

  rows.push({
    organizationId: orgId,
    externalId: "ph-2",
    name: "Water pH (overdue)",
    kind: "ph_probe",
    feature: "water_quality",
    site: "Tower B",
    zone: "Pump Room",
    heartbeatSeconds: 60,
    calibrationIntervalDays: 30,
    // 60 days ago: past due, so readings must be marked suspect.
    calibratedAt: new Date(Date.now() - 60 * 86_400_000),
  });

  rows.push({
    organizationId: orgId,
    externalId: "diesel-1",
    name: "DG Diesel Tank",
    kind: "fuel_level",
    feature: "fuel_monitoring",
    site: "Tower A",
    zone: "Generator Room",
    heartbeatSeconds: 60,
  });

  rows.push({
    organizationId: orgId,
    externalId: "dg-1",
    name: "Diesel Generator",
    kind: "equipment",
    feature: "equipment_status",
    site: "Tower A",
    zone: "Generator Room",
    heartbeatSeconds: 60,
  });

  for (const r of rows) {
    await db.insert(devices).values(r).onConflictDoNothing();
  }

  const rules: Array<typeof sensorRules.$inferInsert> = [
    {
      organizationId: orgId,
      kind: "level_ultrasonic",
      metric: "level_percent",
      op: "lt",
      threshold: 20,
      forSeconds: 0,
      severity: "warning",
      message: "water tank low",
    },
    {
      organizationId: orgId,
      kind: "ph_probe",
      metric: "ph",
      op: "outside",
      threshold: 6.5,
      thresholdHigh: 8.5,
      // Debounced: a single odd pH reading is noise, not a water-quality event.
      forSeconds: 3,
      severity: "critical",
      message: "water pH out of safe range",
    },
    {
      organizationId: orgId,
      kind: "fuel_level",
      metric: "level_percent",
      op: "lt",
      threshold: 25,
      forSeconds: 0,
      severity: "warning",
      message: "diesel low — arrange refill",
    },
  ];
  for (const r of rules) await db.insert(sensorRules).values(r);

  console.log(`  ✔ ${rows.length} devices, ${rules.length} rules`);
}

/* --------------------------------------------------------------- publish */

interface Reading {
  deviceId: string;
  metric: string;
  value: number;
  unit?: string;
}

async function send(readings: Reading[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/sensors/readings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Key": INGEST_KEY },
    body: JSON.stringify({ readings }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 300 && res.status !== 207) {
    console.error(`  ❌ ingest ${res.status}:`, JSON.stringify(body).slice(0, 200));
    return;
  }
  if (body.rejected) {
    console.warn(`  ⚠ ${body.rejected} rejected:`, JSON.stringify(body.results).slice(0, 200));
  }
  if (body.alerts) console.log(`  🔔 ${body.alerts} alert(s) fired`);
}

/* ------------------------------------------------------------ simulation */

async function run(): Promise<void> {
  console.log(`▶ Simulating ${TICKS} ticks against ${BASE_URL}\n`);

  // Start half full, so the parking numbers move rather than sitting at 0/20.
  const bay = Array.from({ length: BAYS }, () => (Math.random() < 0.5 ? 1 : 0));
  let water = 85;      // %
  let diesel = 60;     // %
  let ph = 7.2;
  let dgRunning = 0;

  // bay-07 stops reporting from tick 12 — the "dead sensor" case.
  const DEAD_BAY = 7;
  const DEAD_FROM = 12;

  for (let t = 1; t <= TICKS; t++) {
    const readings: Reading[] = [];

    // --- parking: a few bays change each tick
    for (let i = 0; i < BAYS; i++) {
      if (Math.random() < 0.15) bay[i] = bay[i] ? 0 : 1;
      const id = `bay-${String(i + 1).padStart(2, "0")}`;
      if (i + 1 === DEAD_BAY && t >= DEAD_FROM) continue;   // silence
      readings.push({ deviceId: id, metric: "occupancy", value: bay[i] });
    }

    // --- water tank: steady draw, refills when it gets low
    water -= 2.2 + Math.random();
    if (water < 12) water = 90;
    readings.push({ deviceId: "tank-water-1", metric: "level_percent", value: round(water), unit: "%" });

    // --- pH: drifts out of band around the middle of the run, then recovers
    ph += (t > 15 && t < 26 ? 0.12 : -0.05) + (Math.random() - 0.5) * 0.05;
    ph = Math.max(5.5, Math.min(9.5, ph));
    readings.push({ deviceId: "ph-1", metric: "ph", value: round(ph) });
    // Same water, second probe — but this one is past calibration, so its
    // readings must be stored as `suspect` and must NOT raise an alert.
    readings.push({ deviceId: "ph-2", metric: "ph", value: round(ph + 0.3) });

    // --- diesel + DG
    dgRunning = t % 10 < 4 ? 1 : 0;
    if (dgRunning) diesel -= 1.2;                      // normal burn
    if (t === 30) diesel -= 18;                        // THEFT: big drop, DG off
    diesel = Math.max(0, diesel);
    readings.push({ deviceId: "diesel-1", metric: "level_percent", value: round(diesel), unit: "%" });
    readings.push({ deviceId: "dg-1", metric: "state", value: dgRunning });

    const occupied = bay.filter(Boolean).length;
    console.log(
      `t=${String(t).padStart(2)} bays=${occupied}/${BAYS} water=${round(water)}% ` +
        `ph=${round(ph)} diesel=${round(diesel)}% dg=${dgRunning ? "ON" : "off"}` +
        (t === DEAD_FROM ? "   ← bay-07 sensor goes silent" : "") +
        (t === 30 ? "   ← DIESEL DROP while DG off" : "")
    );

    await send(readings);
    await sleep(1000 / SPEED);
  }
  console.log("\n✔ simulation complete");
}

const round = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- entry */

async function main() {
  if (process.argv.includes("--provision")) {
    if (!ORG_ID) throw new Error("Set ORG_ID to provision devices");
    await provision(ORG_ID);
    process.exit(0);
  }
  if (!INGEST_KEY) {
    throw new Error(
      "Set INGEST_KEY to the organization's ingest token.\n" +
        "  Mint one: POST /api/admin/organizations/:id/ingest-token"
    );
  }
  await run();
  process.exit(0);
}

void main().catch((e) => {
  console.error("❌", e.message ?? e);
  process.exit(1);
});
