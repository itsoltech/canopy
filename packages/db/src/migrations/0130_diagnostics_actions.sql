-- Durable idempotency for an explicitly confirmed report attachment and ordinary thread.
CREATE TABLE diagnostics_investigations (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, request_id)
);
