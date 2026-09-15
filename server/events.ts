// server/events.ts
//
// In-memory event log backing the UI's notification bell. Events are
// operational facts an operator should know about: recorder and worker crashes,
// stalls, cameras added/removed, disk pressure.
//
// TENANT SCOPING IS NOT OPTIONAL HERE. These messages embed the CAMERA NAME
// ("Recording for \"Gate 3 Loading Bay\" stopped"), so serving the global list
// to any authenticated user discloses another client's site layout and
// infrastructure health. Every event therefore carries the owning
// organizationId and `listEvents` filters by it.
//
// In-memory is deliberate: notifications are a "what's happening lately"
// surface, not an audit trail — losing them on restart is acceptable, and it
// keeps recorder supervision off the database hot path. The durable record of
// anything that matters is analytics_events.

import { randomUUID } from "crypto";

export type VmsEventType =
  | "camera_added"
  | "camera_removed"
  | "recorder_started"
  | "recorder_crashed"
  | "recorder_stalled"
  | "recording_saved"
  | "analytics_worker_started"
  | "analytics_worker_crashed"
  | "analytics_worker_unlicensed"
  | "analytics_worker_failing"
  | "storage_warning"
  | "storage_critical"
  // A client approaching or past the storage they were SOLD, which is a
  // different problem from the host's disk filling up: one is a commercial
  // conversation, the other is an outage.
  | "quota_critical"
  | "quota_warning"
  | "quota_exceeded"
  | "sensor_warning"
  | "sensor_critical"
  | "sensor_recovered";

export interface VmsEvent {
  id: string;
  type: VmsEventType;
  message: string;
  cameraId?: string;
  cameraName?: string;
  /** Owning tenant. Undefined = platform-wide notice, visible to everyone. */
  organizationId?: string;
  severity: "info" | "warning" | "critical";
  createdAt: string;
}

const MAX_EVENTS = 500;
const events: VmsEvent[] = [];

const SEVERITY: Record<VmsEventType, VmsEvent["severity"]> = {
  camera_added: "info",
  camera_removed: "info",
  recorder_started: "info",
  recording_saved: "info",
  recorder_stalled: "warning",
  recorder_crashed: "warning",
  analytics_worker_crashed: "warning",
  analytics_worker_started: "info",
  analytics_worker_unlicensed: "warning",
  analytics_worker_failing: "critical",
  quota_warning: "warning",
  quota_critical: "critical",
  quota_exceeded: "critical",
  storage_warning: "warning",
  storage_critical: "critical",
  sensor_warning: "warning",
  sensor_critical: "critical",
  sensor_recovered: "info",
};

export interface EventCamera {
  id: string;
  name: string;
  organizationId?: string | null;
}

export function emitEvent(
  type: VmsEventType,
  message: string,
  camera?: EventCamera,
  organizationId?: string | null
): void {
  const severity = SEVERITY[type] ?? "info";
  events.unshift({
    id: randomUUID(),
    type,
    message,
    cameraId: camera?.id,
    cameraName: camera?.name,
    organizationId: organizationId ?? camera?.organizationId ?? undefined,
    severity,
    createdAt: new Date().toISOString(),
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  // Mirror to the server log with the severity spelled out, so an operator
  // reading journalctl sees the same facts as the UI.
  const line = `[notify:${severity}] ${type} — ${message}`;
  if (severity === "critical") console.error(line);
  else if (severity === "warning") console.warn(line);
  else console.log(line);
}

/**
 * Events visible to one tenant.
 *
 * @param organizationId  the caller's org; null when it cannot be resolved
 * @param isSuperAdmin    platform staff see every tenant's events
 *
 * A client role with no resolvable org gets an EMPTY list, never the global
 * one — failing closed is the whole point.
 */
export function listEvents(
  organizationId: string | null,
  isSuperAdmin = false
): VmsEvent[] {
  if (isSuperAdmin) return [...events];
  if (!organizationId) return [];
  return events.filter(
    (e) => e.organizationId === undefined || e.organizationId === organizationId
  );
}

/** Test helper. */
export function clearEvents(): void {
  events.length = 0;
}
