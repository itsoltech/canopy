-- Shared configuration between linked computers (docs/linked-computers.md, stage 4).
-- One row per item the user shared at least once: a provider instance, an instance's model
-- choices, a user settings section or a project. Values stay in their own tables; this row holds
-- the sharing state, a version vector and the digest of the last value seen locally.
CREATE TABLE computer_shared_items (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  item_key text NOT NULL CHECK (length(item_key) <= 200),
  shared boolean NOT NULL DEFAULT false,
  -- {"<node_id>": counter}: concurrent vectors are a conflict, never last-writer-wins.
  clock jsonb NOT NULL DEFAULT '{}',
  digest text NOT NULL DEFAULT '',
  changed_by text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- Local secrets.id -> random token shared by every copy of the same secret value.
  -- Tokens identify a value without revealing or hashing it.
  tokens jsonb NOT NULL DEFAULT '{}',
  -- Why a copy became local ("Deleted on Laptop B"), shown in the UI.
  note text NOT NULL DEFAULT '',
  PRIMARY KEY (owner_user_id, item_key)
);
-- What a linked computer confirmed for an item: unchanged items are not resent and their
-- secrets cross the link only when the peer does not have that value yet.
CREATE TABLE computer_shared_acks (
  owner_user_id uuid NOT NULL,
  node_id text NOT NULL,
  item_key text NOT NULL,
  digest text NOT NULL,
  shared boolean NOT NULL,
  PRIMARY KEY (owner_user_id, node_id, item_key),
  FOREIGN KEY (owner_user_id, node_id) REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);
-- Durable until the user answers. The other computer's secrets are encrypted with this
-- computer's key; the payload never contains secret values.
CREATE TABLE computer_shared_conflicts (
  owner_user_id uuid NOT NULL,
  item_key text NOT NULL,
  node_id text NOT NULL,
  local_payload jsonb,
  remote_payload jsonb NOT NULL,
  remote_secrets bytea,
  remote_clock jsonb NOT NULL,
  remote_digest text NOT NULL,
  remote_changed_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, item_key, node_id),
  FOREIGN KEY (owner_user_id, node_id) REFERENCES computer_peers(owner_user_id, node_id) ON DELETE CASCADE
);
