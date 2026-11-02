-- Fork from a turn (docs/threads.md, "Fork od tury"): a fork may be a new main thread (same project, owner and
-- worker as its source; its own tree), and its fork point may be any ended turn (completed, failed or
-- interrupted), not only a completed one. The default pin (no fork point given) stays the latest completed turn.

ALTER TABLE threads DROP CONSTRAINT threads_fork_only_side;

CREATE OR REPLACE FUNCTION threads_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent threads%ROWTYPE;
  source threads%ROWTYPE;
  source_turn turns%ROWTYPE;
BEGIN
  IF NEW.kind = 'side' THEN
    SELECT * INTO parent FROM threads WHERE id = NEW.parent_thread_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent thread % not found', NEW.parent_thread_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF parent.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'parent thread % is archived', parent.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.project_id <> parent.project_id OR NEW.owner_user_id <> parent.owner_user_id
       OR NEW.root_thread_id <> parent.root_thread_id OR NEW.depth <> parent.depth + 1 THEN
      RAISE EXCEPTION 'side thread must share project, owner and tree with its parent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.runtime <> parent.runtime
       OR NEW.worker_id IS DISTINCT FROM parent.worker_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id
       OR NEW.cwd IS DISTINCT FROM parent.cwd THEN
      RAISE EXCEPTION 'side thread must run on the same worker and directory as its parent' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.fork_source_thread_id IS NOT NULL THEN
    SELECT * INTO source FROM threads WHERE id = NEW.fork_source_thread_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fork source % not found', NEW.fork_source_thread_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.kind = 'side' AND source.root_thread_id <> NEW.root_thread_id THEN
      RAISE EXCEPTION 'fork source must be in the same thread tree' USING ERRCODE = 'check_violation';
    END IF;
    -- A forked main thread starts its own tree; the provider history it copies lives on the source's worker.
    IF NEW.kind = 'main' AND (NEW.project_id <> source.project_id OR NEW.owner_user_id <> source.owner_user_id
       OR NEW.runtime <> source.runtime OR NEW.worker_id IS DISTINCT FROM source.worker_id) THEN
      RAISE EXCEPTION 'a forked main thread must share project, owner and worker with its source' USING ERRCODE = 'check_violation';
    END IF;
    IF source.provider <> NEW.provider THEN
      RAISE EXCEPTION 'fork must keep the provider (% -> %)', source.provider, NEW.provider USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.fork_after_turn_id IS NULL THEN
      -- Pin the fork point now, so the inherited history never changes afterwards.
      SELECT * INTO source_turn FROM turns
       WHERE thread_id = source.id AND status = 'completed' ORDER BY ordinal DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'fork source % has no completed turn', source.id USING ERRCODE = 'check_violation';
      END IF;
      NEW.fork_after_turn_id := source_turn.id;
    ELSE
      SELECT * INTO source_turn FROM turns WHERE id = NEW.fork_after_turn_id AND thread_id = source.id;
      IF NOT FOUND OR source_turn.status NOT IN ('completed', 'failed', 'interrupted') THEN
        RAISE EXCEPTION 'fork point must be an ended turn of the source thread' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
