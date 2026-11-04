-- The invitation fixes the privilege class before the public exchange.
ALTER TABLE mobile_pairings ADD COLUMN client_kind text NOT NULL DEFAULT 'mobile'
  CHECK (client_kind IN ('mobile', 'desktop'));
ALTER TABLE mobile_devices ADD COLUMN client_kind text NOT NULL DEFAULT 'mobile'
  CHECK (client_kind IN ('mobile', 'desktop'));
ALTER TABLE mobile_devices DROP CONSTRAINT mobile_devices_platform_check;
ALTER TABLE mobile_devices ADD CONSTRAINT mobile_devices_platform_check CHECK (
  (client_kind = 'mobile' AND platform IN ('ios', 'android')) OR
  (client_kind = 'desktop' AND platform IN ('linux', 'darwin', 'win32'))
);
-- Revoking a client never permits its worker to silently recreate UI access.
CREATE TABLE desktop_worker_migrations (
  worker_id uuid PRIMARY KEY REFERENCES workers(id),
  device_id uuid NOT NULL UNIQUE REFERENCES mobile_devices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
