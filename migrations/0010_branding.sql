ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data_url text;

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
