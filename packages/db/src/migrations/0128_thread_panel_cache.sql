-- Display metadata only. Execution, credentials and grants remain authoritative at home.
CREATE TABLE computer_thread_panels (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  thread_id uuid NOT NULL,
  payload bytea NOT NULL,
  PRIMARY KEY (owner_user_id, origin_node_id, thread_id),
  FOREIGN KEY (owner_user_id, origin_node_id)
    REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);
