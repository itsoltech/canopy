-- Raw worker events rejected by PostgreSQL data validation. No text conversion of the payload.
CREATE TABLE worker_event_quarantine (
  event_id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  journal_id text NOT NULL,
  -- A thread or a bot; both use the worker journal. Retain evidence until worker deletion.
  thread_id uuid NOT NULL,
  journal_seq bigint NOT NULL,
  sqlstate text NOT NULL CHECK (sqlstate ~ '^22[0-9A-Z]{3}$'),
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
