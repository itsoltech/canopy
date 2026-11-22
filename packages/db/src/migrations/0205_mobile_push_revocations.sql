ALTER TABLE mobile_push_grants ADD COLUMN reattest_due boolean NOT NULL DEFAULT false;

CREATE TABLE mobile_push_revocations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  origin text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  expo_token_hash bytea NOT NULL,
  encrypted_bearer bytea NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE INDEX mobile_push_revocations_due ON mobile_push_revocations (owner_user_id, origin, next_attempt_at);
CREATE INDEX mobile_push_revocations_expiry ON mobile_push_revocations (owner_user_id, expires_at);
