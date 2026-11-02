-- Managing the queue (docs/ui-api.md, "Kolejka"): the user reorders, edits, deletes and steers queued turns.
-- The queue's order is the turns' ordinal (nextTurn starts the lowest queued one): a reorder permutes the ordinals
-- of the turns it moves among themselves, so started turns keep their place in the timeline.

-- A queued turn the user took out of the queue: deleted (can be restored while it is still cancelled) or steered
-- into the running turn (turn_steers.from_turn_id; back in the queue at its place when the steer cannot join).
-- Withdrawn turns are cancelled and the timeline does not show them.
ALTER TABLE turns ADD COLUMN withdrawn text CHECK (withdrawn IN ('deleted', 'steered'));
ALTER TABLE turns ADD CONSTRAINT turns_withdrawn_cancelled CHECK (withdrawn IS NULL OR status = 'cancelled');

-- Grows with every edit of a queued turn's input: an edit names the revision it started from (two devices never
-- overwrite each other unnoticed) and the scheduler starts a turn only with the input it read.
ALTER TABLE turns ADD COLUMN revision integer NOT NULL DEFAULT 0;

-- A steer made from a queued turn (SteerQueuedTurn): falling back, it brings that turn back instead of a new one.
ALTER TABLE turn_steers ADD COLUMN from_turn_id uuid;
ALTER TABLE turn_steers ADD FOREIGN KEY (from_turn_id, thread_id) REFERENCES turns (id, thread_id);
