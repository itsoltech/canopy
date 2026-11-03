CREATE TABLE worker_ssh_keys (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  private_key bytea NOT NULL,
  key_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE worker_ssh_hosts (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, host, port)
);
