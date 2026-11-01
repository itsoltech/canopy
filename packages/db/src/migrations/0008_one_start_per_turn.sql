-- At most one live StartTurn per turn (docs/durability.md, 4.2). Two scheduler passes at once (a turn
-- finishing while a message arrives, or two gateway instances) could both see "no StartTurn yet" and
-- start the same turn twice. Old duplicates are expired first; the oldest one stands.
UPDATE worker_commands c SET status = 'expired'
 WHERE c.kind = 'startTurn' AND c.status IN ('pending', 'delivered', 'completed')
   AND EXISTS (SELECT 1 FROM worker_commands d
                WHERE d.turn_id = c.turn_id AND d.kind = 'startTurn' AND d.status IN ('pending', 'delivered', 'completed')
                  AND (d.created_at, d.id) < (c.created_at, c.id));

CREATE UNIQUE INDEX worker_commands_one_start ON worker_commands (turn_id)
  WHERE kind = 'startTurn' AND status IN ('pending', 'delivered', 'completed');
