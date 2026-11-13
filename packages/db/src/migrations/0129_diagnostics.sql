CREATE TABLE diagnostics_state (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  computer_id text NOT NULL,
  payload bytea NOT NULL CHECK (octet_length(payload) <= 65536),
  persisted_through timestamptz,
  PRIMARY KEY (owner_user_id, computer_id)
);

CREATE TABLE diagnostics_rollups (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  computer_id text NOT NULL,
  resolution integer NOT NULL CHECK (resolution IN (60, 3600)),
  bucket_start timestamptz NOT NULL,
  payload bytea NOT NULL CHECK (octet_length(payload) <= 65536),
  compacted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, computer_id, resolution, bucket_start),
  FOREIGN KEY (owner_user_id, computer_id) REFERENCES diagnostics_state ON DELETE CASCADE,
  CHECK (date_trunc('minute', bucket_start) = bucket_start),
  CHECK (resolution = 60 OR date_trunc('hour', bucket_start) = bucket_start)
);

-- A separate permission from thread sharing. Only the home can create it.
CREATE TABLE diagnostics_grants (
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

-- Bounded last-known overviews are separate from the home's 64 KiB state.
CREATE TABLE diagnostics_peer_cache (
  owner_user_id uuid NOT NULL,
  computer_id text NOT NULL,
  payload bytea NOT NULL CHECK (octet_length(payload) <= 16384),
  received_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  PRIMARY KEY (owner_user_id, computer_id),
  FOREIGN KEY (owner_user_id, computer_id)
    REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);
