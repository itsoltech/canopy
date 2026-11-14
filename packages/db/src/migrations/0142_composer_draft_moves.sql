-- Content-free receipts survive saving or sending on the receiving device.
CREATE TABLE composer_draft_moves (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  source_device_id text NOT NULL,
  source_revision bigint NOT NULL,
  device_name text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  PRIMARY KEY (owner_user_id, draft_id, source_device_id)
);
