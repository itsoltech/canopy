ALTER TABLE turns ADD COLUMN background_task_item_id text;

ALTER TABLE bot_thread_watches
  ADD COLUMN continuation_checked_seq bigint,
  ADD COLUMN continuation_check_at timestamptz;

CREATE UNIQUE INDEX turns_background_task_followup ON turns (thread_id, background_task_item_id)
  WHERE background_task_item_id IS NOT NULL;

CREATE INDEX turns_thread_start_sequence ON turns (thread_id, first_seq) WHERE first_seq IS NOT NULL;

CREATE INDEX thread_items_bot_background_tasks ON thread_items (thread_id, turn_id)
  WHERE type = 'background_task' AND content->'backgroundTask'->>'providerRunId' IS NOT NULL;
