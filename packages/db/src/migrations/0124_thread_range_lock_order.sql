-- A clock can be updated several times by deferred journal triggers. PostgreSQL
-- rechecks even an unchanged FK when the previous row version is from this tx.
-- Never take a new threads KEY SHARE under the global journal advisory lock:
-- ingest/moves/SendMessage already take that row before their deferred journal.
-- An immutable anchor preserves the cascade without locking the execution row.
CREATE TABLE thread_replication_sources (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE
);
INSERT INTO thread_replication_sources(thread_id) SELECT thread_id FROM thread_replication_clock;
ALTER TABLE thread_replication_clock DROP CONSTRAINT thread_replication_clock_thread_id_fkey;
ALTER TABLE thread_replication_clock ADD CONSTRAINT thread_replication_clock_thread_id_fkey
  FOREIGN KEY(thread_id) REFERENCES thread_replication_sources(thread_id) ON DELETE CASCADE;
