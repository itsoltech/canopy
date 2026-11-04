CREATE TABLE desktop_updates (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE REFERENCES mobile_devices(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  state jsonb NOT NULL DEFAULT '{}',
  command jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
