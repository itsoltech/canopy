-- One-time pairing codes (64 random bits) and device tokens (256 bits): SHA-256 only.
CREATE TABLE mobile_devices (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX mobile_devices_owner ON mobile_devices(owner_user_id, created_at DESC);
CREATE TABLE mobile_pairings (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  device_id uuid REFERENCES mobile_devices(id),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (device_id IS NULL))
);
CREATE INDEX mobile_pairings_owner ON mobile_pairings(owner_user_id, created_at DESC);
