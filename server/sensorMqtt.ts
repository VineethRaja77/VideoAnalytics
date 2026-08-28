// server/sensorMqtt.ts
//
// Optional MQTT bridge. Most field gateways speak MQTT rather than HTTP, so
// this subscribes to a broker and funnels messages into the SAME ingestReading()
// path the HTTP route uses — one code path, one set of rules, one place where
// tenant scoping is enforced.
//
// TOPIC CONTRACT
//     vms/<orgIngestToken>/<deviceExternalId>/<metric>
//   payload: a bare number, or {"value": 12.3, "unit": "%", "at": "..."}
//
// The token sits in the topic because MQTT 3.1.1 has no per-message auth and
// most cheap gateways cannot set custom headers. It is the same per-org token
// the HTTP path uses, hashed for lookup, and it NEVER identifies the tenant
// from the payload — a gateway publishing another org's device id gets
// "unknown device", not a cross-tenant write.
//
// SECURITY NOTE: a topic-embedded credential is visible to anything that can
// read broker traffic, so the broker MUST be on a private network or TLS. Where
// the gateway can send HTTP headers, prefer POST /api/sensors/readings.
//
// Disabled unless MQTT_URL is set. Nothing here runs on a video-only install.

import mqtt, { type MqttClient } from "mqtt";
import { storage } from "./storage";
import { hashIngestToken } from "./crypto";
import { ingestReading } from "./sensors";

let client: MqttClient | null = null;

/** orgToken hash -> orgId. Avoids a DB round trip per message. */
const orgCache = new Map<string, { orgId: string; at: number }>();
const ORG_CACHE_MS = 5 * 60_000;

async function orgForToken(token: string): Promise<string | null> {
  const hash = hashIngestToken(token);
  const hit = orgCache.get(hash);
  if (hit && Date.now() - hit.at < ORG_CACHE_MS) return hit.orgId;

  const org = await storage.getOrganizationByIngestKeyHash(hash);
  if (!org) return null;
  orgCache.set(hash, { orgId: org.id, at: Date.now() });
  return org.id;
}

/** Rotating a token must take effect without a restart. */
export function clearOrgCache(): void {
  orgCache.clear();
}

interface ParsedPayload {
  value: number;
  unit?: string | null;
  at?: Date;
}

/**
 * Accepts a bare number ("42.5") or a JSON object. Bare numbers exist because
 * many PLC-style gateways publish exactly that and cannot be reconfigured.
 */
export function parsePayload(raw: string): ParsedPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const bare = Number(trimmed);
  if (Number.isFinite(bare)) return { value: bare };

  try {
    const j = JSON.parse(trimmed);
    const v = Number(j.value ?? j.v);
    if (!Number.isFinite(v)) return null;
    return {
      value: v,
      unit: j.unit ?? null,
      at: j.at ? new Date(j.at) : undefined,
    };
  } catch {
    return null;
  }
}

export interface TopicParts {
  token: string;
  externalId: string;
  metric: string;
}

export function parseTopic(topic: string): TopicParts | null {
  const p = topic.split("/").filter(Boolean);
  // vms / token / device / metric
  if (p.length !== 4 || p[0] !== "vms") return null;
  return { token: p[1], externalId: p[2], metric: p[3] };
}

/** Handle one message. Exported so tests can drive it without a broker. */
export async function handleMessage(topic: string, payload: string): Promise<void> {
  const parts = parseTopic(topic);
  if (!parts) {
    console.warn(`⚠ MQTT: ignoring topic "${topic}" — expected vms/<token>/<device>/<metric>`);
    return;
  }

  const orgId = await orgForToken(parts.token);
  if (!orgId) {
    // Never echo the token itself into the log — it is a bearer credential and
    // logs are widely readable.
    console.warn(
      `⚠ MQTT: unknown ingest token in topic for device "${parts.externalId}" — message dropped`
    );
    return;
  }

  const parsed = parsePayload(payload);
  if (!parsed) {
    console.warn(
      `⚠ MQTT: unparseable payload for ${parts.externalId}/${parts.metric}: ` +
        `"${payload.slice(0, 60)}" (expected a number or {"value": n})`
    );
    return;
  }

  const res = await ingestReading(orgId, {
    externalId: parts.externalId,
    metric: parts.metric,
    value: parsed.value,
    unit: parsed.unit,
    at: parsed.at,
  });

  if (!res.ok) {
    // Rate-limited by nature: a mis-commissioned gateway repeats the same id,
    // so this names the id and the reason rather than a generic failure.
    console.warn(`⚠ MQTT: rejected reading from "${parts.externalId}": ${res.reason}`);
  }
}

export function startSensorMqtt(): void {
  const url = process.env.MQTT_URL;
  if (!url) return; // sensors are optional; a video-only install runs nothing

  if (client) return;
  client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    clientId: `vms-server-${Math.random().toString(16).slice(2, 10)}`,
  });

  client.on("connect", () => {
    console.log(`📡 MQTT connected to ${url}`);
    client!.subscribe("vms/+/+/+", { qos: 1 }, (err) => {
      if (err) {
        console.error("❌ MQTT subscribe to vms/+/+/+ failed — no sensor data will arrive:", err);
      } else {
        console.log("📡 MQTT subscribed: vms/<token>/<device>/<metric>");
      }
    });
  });

  client.on("message", (topic, payload) => {
    // Never let one bad message kill the subscriber.
    void handleMessage(topic, payload.toString()).catch((err) =>
      console.error(`❌ MQTT handler failed for topic "${topic}":`, err)
    );
  });

  client.on("error", (err) => console.error("❌ MQTT client error:", err));
  client.on("offline", () => console.warn("⚠ MQTT offline — sensor readings are not arriving"));
  client.on("reconnect", () => console.log("↻ MQTT reconnecting…"));
}

export async function stopSensorMqtt(): Promise<void> {
  if (!client) return;
  await client.endAsync();
  client = null;
}
