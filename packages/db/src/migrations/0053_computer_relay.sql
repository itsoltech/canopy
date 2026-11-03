-- Indirect entries share mirror ownership/cascades, but never certificate trust.
ALTER TABLE computer_identity ADD COLUMN relay_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE computer_peers ADD COLUMN relay_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE computer_peers ADD COLUMN via_node_id text;
ALTER TABLE computer_peers ADD COLUMN relay_role text NOT NULL DEFAULT '';
ALTER TABLE computer_peers ADD CONSTRAINT computer_relay_role CHECK (
  (via_node_id IS NULL AND relay_role='') OR
  (via_node_id IS NOT NULL AND via_node_id<>node_id AND relay_role IN ('home','origin','both') AND certificate='' AND fingerprint='')
);
ALTER TABLE computer_peers ADD CONSTRAINT computer_relay_via FOREIGN KEY(owner_user_id,via_node_id)
  REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE;

-- Directed opt-in: recipient may access home, both must be direct partners.
CREATE TABLE computer_relay_grants (
  owner_user_id uuid NOT NULL,
  recipient_node_id text NOT NULL,
  home_node_id text NOT NULL,
  PRIMARY KEY(owner_user_id,recipient_node_id,home_node_id),
  CHECK(recipient_node_id<>home_node_id),
  FOREIGN KEY(owner_user_id,recipient_node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id,home_node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE
);
