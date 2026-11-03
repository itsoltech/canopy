-- Stage 6: every way to reach a linked computer is a route with its source and history.
-- Routes replace the ordered address list of stage 1; unlink removes them with the peer.
CREATE TABLE computer_routes (
  owner_user_id uuid NOT NULL,
  node_id text NOT NULL,
  address text NOT NULL,
  -- manual: entered by the user (or used for pairing); lan: found by local network discovery
  -- after a pinned handshake; announced: sent by the partner over the link.
  source text NOT NULL CHECK (source IN ('manual', 'lan', 'announced')),
  added_at timestamptz NOT NULL DEFAULT now(),
  last_success timestamptz,
  last_failure timestamptz,
  latency_ms integer CHECK (latency_ms >= 0),
  PRIMARY KEY (owner_user_id, node_id, address),
  FOREIGN KEY (owner_user_id, node_id) REFERENCES computer_peers (owner_user_id, node_id) ON DELETE CASCADE
);
-- The stage 1 list was ordered by the last successful route; keep that order.
INSERT INTO computer_routes (owner_user_id, node_id, address, source, added_at)
  SELECT p.owner_user_id, p.node_id, a.address, 'announced', p.linked_at - a.position * interval '1 millisecond'
  FROM computer_peers p, jsonb_array_elements_text(p.addresses) WITH ORDINALITY AS a(address, position)
  ON CONFLICT DO NOTHING;
ALTER TABLE computer_peers DROP COLUMN addresses;
-- Per computer, default on. Off: no announcements, no queries, LAN routes are forgotten.
ALTER TABLE computer_identity ADD COLUMN lan_discovery boolean NOT NULL DEFAULT true;
