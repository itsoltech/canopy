-- A bounded resumable suffix, including tombstones, for client cache warming.
CREATE TABLE thread_mirror_recent_ranges (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  thread_id uuid NOT NULL,
  epoch uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  payload bytea NOT NULL,
  PRIMARY KEY(owner_user_id,origin_node_id,thread_id,epoch,seq),
  FOREIGN KEY(owner_user_id,origin_node_id,thread_id)
    REFERENCES thread_range_state(owner_user_id,origin_node_id,thread_id) ON DELETE CASCADE
);
