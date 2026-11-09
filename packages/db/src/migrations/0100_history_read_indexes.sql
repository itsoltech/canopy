-- The migrator holds a transaction/advisory lock. CONCURRENTLY is not valid here.
-- Preserve transcript rows; these indexes bound metadata and paged history reads.
CREATE INDEX turns_unseen ON turns (thread_id, last_seq DESC)
  WHERE status IN ('completed', 'failed', 'interrupted');
CREATE INDEX thread_items_turn_order ON thread_items (thread_id, turn_id, first_seq);
CREATE INDEX thread_items_last_answer ON thread_items (thread_id, first_seq DESC)
  WHERE type = 'agent_message';
CREATE INDEX thread_events_notices ON thread_events (thread_id, seq DESC) WHERE kind = 'notice';
