-- CLIProxyAPI management key (encrypted like the proxy secret). The gateway alone reads upstream accounts with it.
ALTER TABLE proxies ADD COLUMN management_secret_id uuid REFERENCES secrets(id);
