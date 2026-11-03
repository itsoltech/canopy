CREATE TABLE computer_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  node_id text NOT NULL UNIQUE,
  name text NOT NULL,
  certificate text NOT NULL,
  private_key bytea NOT NULL,
  listener_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE computer_peers (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  node_id text NOT NULL,
  name text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  addresses jsonb NOT NULL DEFAULT '[]',
  certificate text NOT NULL,
  fingerprint text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL DEFAULT '',
  min_protocol integer NOT NULL DEFAULT 0,
  max_protocol integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unreachable',
  status_since timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz,
  update_node_id text NOT NULL DEFAULT '',
  PRIMARY KEY (owner_user_id, node_id)
);
CREATE TABLE computer_pairings (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  secret_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
-- Durable global budget: restarting the gateway cannot reset brute-force limits.
CREATE TABLE computer_pairing_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
INSERT INTO computer_pairing_budget DEFAULT VALUES;
-- No active trust. A returning former peer receives only a signed unlink notice.
CREATE TABLE computer_revocations (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  node_id text NOT NULL,
  PRIMARY KEY (owner_user_id, node_id)
);
