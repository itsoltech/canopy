-- Turn end states and durable threads (docs/durability.md, "Stany tury i wątku").

-- A turn ends completed, interrupted or failed. A failed turn says where the error came from (platform: our side;
-- harness: Codex/Claude reported it) with its message in `error` and an optional short code; an interrupted turn
-- says who interrupted it (user: someone asked through the platform; system: e.g. the worker restarted mid-turn)
-- with its reason in `interrupt_reason`. A late turn_finished that changes the status rewrites all of them.
ALTER TABLE turns ADD COLUMN error_source text CHECK (error_source IN ('platform', 'harness'));
ALTER TABLE turns ADD COLUMN interrupt_source text CHECK (interrupt_source IN ('user', 'system'));
ALTER TABLE turns ADD COLUMN error_code text;
ALTER TABLE turns ADD CONSTRAINT turns_error_source_failed CHECK (error_source IS NULL OR status = 'failed');
ALTER TABLE turns ADD CONSTRAINT turns_interrupt_source_interrupted CHECK (interrupt_source IS NULL OR status = 'interrupted');

-- Existing rows: a failed turn the worker reported (turn_finished) failed in the harness, one the gateway failed
-- (a turn that could not start, a thread that could not be created) on our side. Interruptions the gateway made
-- for a worker that no longer ran the turn are the system's; the others were asked for.
UPDATE turns u SET error_source = CASE
    WHEN EXISTS (SELECT 1 FROM thread_events e WHERE e.thread_id = u.thread_id AND e.turn_id = u.id AND e.kind = 'turn_finished') THEN 'harness'
    ELSE 'platform' END
 WHERE status = 'failed';
UPDATE turns SET interrupt_source = CASE
    WHEN interrupt_reason IN ('worker restarted', 'the turn was no longer running on the worker') OR interrupt_reason LIKE 'superseded%' THEN 'system'
    ELSE 'user' END
 WHERE status = 'interrupted';

-- A thread is usable after any turn end: only a thread that could not be created (no provider thread) stays failed.
-- interrupted and failed threads with a provider thread go back to idle (their last turn keeps the outcome).
UPDATE threads SET status = 'idle'
 WHERE archived_at IS NULL AND (status = 'interrupted' OR (status = 'failed' AND provider_thread_id IS NOT NULL));
