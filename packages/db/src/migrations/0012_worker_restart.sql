-- Worker restarts (docs/durability.md, 3.4; docs/goals.md).

-- A goal command the worker could not carry out (SetGoal, a Claude /goal turn that did not start) is shown on the
-- goal (ui.Goal.error) instead of leaving it waiting for the harness forever. Cleared by the next goal command.
ALTER TABLE goals ADD COLUMN error text;
ALTER TABLE goals ADD COLUMN error_at timestamptz;
ALTER TABLE goals ADD CONSTRAINT goals_error_time CHECK ((error IS NULL) = (error_at IS NULL));

-- provider_thread_id stays set once, except while no turn of the thread has started: then the provider thread
-- has no history and may be replaced (Codex writes a thread's rollout with its first turn, so a thread created
-- just before a worker restart cannot be resumed and the worker starts a new one: thread_ready.replaces_...).
CREATE OR REPLACE FUNCTION threads_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
      NEW.runtime, NEW.provider, NEW.worker_id, NEW.workspace_id, NEW.cwd,
      NEW.fork_source_thread_id, NEW.fork_after_turn_id)
     IS DISTINCT FROM
     (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
      OLD.runtime, OLD.provider, OLD.worker_id, OLD.workspace_id, OLD.cwd,
      OLD.fork_source_thread_id, OLD.fork_after_turn_id) THEN
    RAISE EXCEPTION 'thread placement and lineage are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id
     AND (NEW.provider_thread_id IS NULL
          OR EXISTS (SELECT 1 FROM turns WHERE thread_id = NEW.id AND started_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'provider_thread_id is set once (replaceable only before the first turn)' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
