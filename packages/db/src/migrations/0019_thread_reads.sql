-- What each user has seen of a thread: events up to seen_seq (the thread page marks it once the latest agent
-- message was on screen). A finished turn past it is "unseen" (Thread.unseen_result) until then.
CREATE TABLE thread_reads (
  user_id uuid NOT NULL REFERENCES users(id),
  thread_id uuid NOT NULL REFERENCES threads(id),
  seen_seq bigint NOT NULL DEFAULT 0,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);

-- Existing threads count as seen by their owner, so the inbox does not light up all at once.
INSERT INTO thread_reads (user_id, thread_id, seen_seq)
SELECT t.owner_user_id, t.id, t.last_seq FROM threads t
ON CONFLICT DO NOTHING;
