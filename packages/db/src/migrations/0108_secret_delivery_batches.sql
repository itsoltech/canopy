-- Round-robin delivery survives a gateway restart with one cursor write per batch.
CREATE TABLE worker_secret_delivery_cursors (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  last_id uuid
);

-- A reconnect resets receipts in bounded keyset batches, including after another restart.
CREATE TABLE worker_secret_replays (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  last_id uuid
);
