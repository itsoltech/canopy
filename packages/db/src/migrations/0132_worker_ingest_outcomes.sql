-- Quarantine also resolves permanent constraints and exhausted per-thread retries.
ALTER TABLE worker_event_quarantine DROP CONSTRAINT worker_event_quarantine_sqlstate_check;
ALTER TABLE worker_event_quarantine ADD CONSTRAINT worker_event_quarantine_sqlstate_check
  CHECK (sqlstate ~ '^[0-9A-Z]{5}$');
ALTER TABLE worker_event_quarantine ADD COLUMN reason text NOT NULL DEFAULT 'data_error'
  CHECK (reason IN ('data_error', 'archived_thread', 'retry_exhausted'));
