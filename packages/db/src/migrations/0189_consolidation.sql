-- A fenced source can be consumed once. The receipt and the imported data commit together.
CREATE TABLE gateway_consolidation_receipts (
  operation_id uuid PRIMARY KEY,
  source_node_id text NOT NULL UNIQUE CHECK (source_node_id ~ '^[a-f0-9]{64}$'),
  source_owner_user_id uuid NOT NULL,
  target_owner_user_id uuid NOT NULL REFERENCES users(id),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  approval_digest text NOT NULL CHECK (approval_digest ~ '^[a-f0-9]{64}$'),
  counts jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway_consolidation_ids (
  operation_id uuid NOT NULL REFERENCES gateway_consolidation_receipts(operation_id),
  kind text NOT NULL CHECK (kind IN ('project','workspace','worker','thread','bot','schedule','attachment','agent','connector','secret')),
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  PRIMARY KEY (operation_id, kind, source_id)
);
