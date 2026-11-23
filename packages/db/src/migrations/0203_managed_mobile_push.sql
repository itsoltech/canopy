CREATE TABLE mobile_push_enrollments (
  device_id uuid PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  relay_id uuid,
  origin text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  expo_token_hash bytea NOT NULL,
  encrypted_token bytea NOT NULL,
  encrypted_claim bytea,
  expires_at timestamptz NOT NULL
);

CREATE TABLE mobile_push_grants (
  device_id uuid PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  origin text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  expo_token_hash bytea NOT NULL,
  encrypted_bearer bytea NOT NULL,
  expires_at timestamptz NOT NULL
);

ALTER TABLE mobile_push_subscriptions ADD COLUMN managed_grant_id uuid;
