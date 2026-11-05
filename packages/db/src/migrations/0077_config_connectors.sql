-- OAuth app definitions participate in configuration bootstrap with their original save time.
ALTER TABLE connector_oauth_apps ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Account credentials and headers are seeded by ConfigSync inside the gateway, where the encryption key lives.
-- Status, namespace, last use, OAuth sessions, executions and worker/bot grants remain local.
