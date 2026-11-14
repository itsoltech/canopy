CREATE TABLE provider_usage (
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  provider integer NOT NULL CHECK (provider IN (1, 2, 3)),
  profile_id text NOT NULL,
  account_key text NOT NULL CHECK (length(account_key) = 64),
  config_version bigint NOT NULL,
  snapshot jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (worker_id, provider, profile_id)
);
