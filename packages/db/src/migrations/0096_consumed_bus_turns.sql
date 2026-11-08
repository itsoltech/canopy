-- Consuming an input is not cancelling work: it never entered the provider.
ALTER TABLE turns DROP CONSTRAINT turns_withdrawn_check;
ALTER TABLE turns ADD CONSTRAINT turns_withdrawn_check
  CHECK (withdrawn IN ('deleted', 'steered', 'consumed'));

-- Repair history already withdrawn by bus reads, without hiding actual cancellations.
UPDATE turns u SET withdrawn = 'consumed'
WHERE u.status = 'cancelled' AND u.started_at IS NULL AND u.withdrawn IS NULL
  AND NOT EXISTS (SELECT 1 FROM worker_commands w WHERE w.turn_id = u.id AND w.kind = 'startTurn')
  AND EXISTS (SELECT 1 FROM agent_bus_calls c WHERE
    (c.target_turn_id = u.id AND c.message_consumed IS NOT NULL)
    OR (c.notified_turn_id = u.id AND c.notify_status IN ('consumed_by_wait', 'consumed_by_read', 'superseded')));
