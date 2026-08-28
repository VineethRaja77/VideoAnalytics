-- 0007_sensors.sql
--
-- Physical-sensor telemetry: parking bays, tank levels, water quality, fuel,
-- energy meters, equipment status.
--
-- ONE generic model, not a table per sensor type. Adding "water pH" after
-- "diesel level" must be inserting rows, not writing a module.
--
-- Safe to run on an existing install: creates only, drops nothing.

CREATE TABLE IF NOT EXISTS devices (
  id                        varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           varchar NOT NULL REFERENCES organizations(id),
  external_id               text NOT NULL,          -- id used in MQTT topics
  name                      text NOT NULL,
  kind                      text NOT NULL,          -- ultrasonic_bay, ph_probe, ...
  site                      text,
  zone                      text,
  location                  text,
  feature                   text NOT NULL,          -- the licensable feature
  enabled                   boolean NOT NULL DEFAULT true,

  -- Silence past this window means UNKNOWN, never "vacant" or "full".
  heartbeat_seconds         integer NOT NULL DEFAULT 300,

  -- NULL interval = nothing to calibrate (level, flow, energy).
  calibration_interval_days integer,
  calibrated_at             timestamp,

  config                    jsonb,
  created_at                timestamp NOT NULL DEFAULT now()
);

-- One external_id per org. Two gateways publishing the same id inside one
-- tenant is a commissioning error that must fail loudly at insert.
CREATE UNIQUE INDEX IF NOT EXISTS devices_org_external_unique
  ON devices (organization_id, external_id);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices (organization_id);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id varchar NOT NULL REFERENCES organizations(id),
  device_id       varchar NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric          text NOT NULL,
  value           double precision NOT NULL,
  unit            text,
  quality         text NOT NULL DEFAULT 'good',   -- good | suspect | stale
  at              timestamp NOT NULL DEFAULT now()
);

-- The two access patterns: one device's history (a chart), and everything in
-- an org over a window (the dashboard).
CREATE INDEX IF NOT EXISTS readings_device_time_idx ON sensor_readings (device_id, at);
CREATE INDEX IF NOT EXISTS readings_org_time_idx    ON sensor_readings (organization_id, at);

CREATE TABLE IF NOT EXISTS sensor_rules (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id varchar NOT NULL REFERENCES organizations(id),
  device_id       varchar REFERENCES devices(id) ON DELETE CASCADE,  -- NULL = by kind
  kind            text,
  metric          text NOT NULL,
  op              text NOT NULL,            -- lt | lte | gt | gte | eq | outside
  threshold       double precision NOT NULL,
  threshold_high  double precision,         -- upper bound for `outside`
  for_seconds     integer NOT NULL DEFAULT 0,  -- debounce; 0 = fire immediately
  severity        text NOT NULL DEFAULT 'warning',
  message         text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensor_rules_org_idx ON sensor_rules (organization_id);
