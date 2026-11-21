CREATE TABLE gateway_relocation_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('draining', 'drained', 'committed'))
);

CREATE TABLE gateway_relocation_receipts (
  run_id uuid PRIMARY KEY,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  restored_at timestamptz NOT NULL DEFAULT now()
);
