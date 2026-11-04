-- One switch per computer lets phones and linked computers connect: a pinned TLS listener on every
-- interface. Settings live here and are edited in the app; the port is chosen once and kept.
CREATE TABLE network_access (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  port integer CHECK (port BETWEEN 1 AND 65535),
  -- Extra names or addresses (a MagicDNS name, a public DNS name), each "host" or "host:port".
  hostnames text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hostnames) <= 8),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A computer that already linked others keeps accepting them; the old listener switch goes away.
INSERT INTO network_access (owner_user_id, enabled)
  SELECT i.owner_user_id, i.listener_enabled AND EXISTS (SELECT 1 FROM computer_peers p WHERE p.owner_user_id = i.owner_user_id)
  FROM computer_identity i;
ALTER TABLE computer_identity DROP COLUMN listener_enabled;
