-- A read grant never grants log export. Onward access is explicit and tied to both peers.
CREATE TABLE diagnostics_log_grants (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_computer_id text NOT NULL,
  via_node_id text NOT NULL,
  PRIMARY KEY (owner_user_id, origin_computer_id),
  FOREIGN KEY (owner_user_id, origin_computer_id)
    REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, via_node_id)
    REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE,
  CHECK (origin_computer_id <> via_node_id)
);
