-- Reusable, owner-scoped upstream connections. Secret values stay in secrets (AES-256-GCM).
-- Existing endpoint definitions are converted by the gateway at startup, where the master key is available
-- to deduplicate independently encrypted keys. The conversion is transactional and idempotent.
CREATE TABLE proxies (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('cliproxyapi', 'anthropic', 'openai')),
  base_url text NOT NULL,
  secret_id uuid REFERENCES secrets(id),
  fingerprint text NOT NULL,
  codex jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id)
);
CREATE INDEX proxies_owner ON proxies(owner_user_id);
CREATE INDEX proxies_fingerprint ON proxies(owner_user_id, fingerprint);
ALTER TABLE provider_instances ADD COLUMN proxy_id uuid REFERENCES proxies(id);
ALTER TABLE provider_instance_workers ADD COLUMN proxy_id uuid REFERENCES proxies(id);
CREATE INDEX provider_instances_proxy ON provider_instances(proxy_id);
CREATE INDEX provider_instance_workers_proxy ON provider_instance_workers(proxy_id);
