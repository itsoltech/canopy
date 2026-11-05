ALTER TABLE bot_approvals DROP CONSTRAINT bot_approvals_status_check;
ALTER TABLE bot_approvals ADD CONSTRAINT bot_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'discarded', 'expired'));

-- Repair cards whose waiting turn has already ended. No answer was given.
UPDATE bot_approvals a SET status = 'expired', answered_at = now()
  FROM bot_turns t WHERE a.turn_id = t.id AND a.status = 'pending'
    AND (t.status IN ('completed', 'interrupted', 'failed') OR EXISTS (
      SELECT 1 FROM bot_harness_turns h WHERE h.turn_id = t.id AND h.outcome IS NOT NULL
    ));
