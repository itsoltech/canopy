-- CLIProxyAPI management key (encrypted like the proxy secret). The gateway alone reads upstream accounts with it.
ALTER TABLE proxies ADD COLUMN management_secret_id uuid REFERENCES secrets(id);
-- The last sanitized read of the upstream accounts and the key/URL identity it was made with. Shared by restarts
-- and gateway processes: a rejected key stays rejected for its identity until the key changes or Refresh is pressed.
ALTER TABLE proxies ADD COLUMN management_status jsonb;
ALTER TABLE proxies ADD COLUMN management_identity text;
-- A lease: the last time a process started a read, and for which identity. Spaces reads across processes.
ALTER TABLE proxies ADD COLUMN management_read_at timestamptz;
ALTER TABLE proxies ADD COLUMN management_read_identity text;
