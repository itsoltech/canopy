-- Pending migrations share a transaction. Earlier backfills can leave deferred checks queued on rows whose
-- tables this migration alters.
SET CONSTRAINTS ALL IMMEDIATE;

-- Background runs (routines) park their questions and approvals: the card stays with the owner, the run ends
-- and the queue moves on. The decision starts a new background run of the same origin (docs/bots.md).
ALTER TABLE bot_approvals ADD COLUMN parked boolean NOT NULL DEFAULT false;
-- The parked run's final text, so the continuation knows what it was doing.
ALTER TABLE bot_approvals ADD COLUMN note text NOT NULL DEFAULT '' CHECK (length(note) <= 4000);
CREATE INDEX bot_approvals_parked_due ON bot_approvals (expires_at) WHERE parked AND status = 'pending';

-- A continuation that runs the approved call of a parked approval before its model starts.
ALTER TABLE bot_turns ADD COLUMN resume_approval_id uuid REFERENCES bot_approvals (id);
