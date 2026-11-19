ALTER TABLE bot_harness_turns ADD COLUMN started_journal_id text;
ALTER TABLE worker_connections
  ADD COLUMN bot_journal_id text,
  ADD COLUMN bot_journal_pending jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN bot_presence_until timestamptz;

-- Before this migration, bot events were published only after journal admission.
-- Preserve already ingested starts and progress for jobs that can still resume.
WITH admitted AS (
  SELECT h.turn_id, saved.journal_id
  FROM bot_turns t
  JOIN bot_harness_turns h ON h.turn_id=t.id
  CROSS JOIN LATERAL (
    SELECT e.journal_id FROM bot_harness_events e
    WHERE e.turn_id=t.id AND e.worker_id=h.worker_id AND e.journal_id <> ''
    ORDER BY e.journal_seq DESC LIMIT 1
  ) saved
  WHERE h.outcome IS NULL AND t.status IN ('queued','running','waiting')
)
UPDATE bot_harness_turns h SET started_journal_id=admitted.journal_id
FROM admitted WHERE h.turn_id=admitted.turn_id;
