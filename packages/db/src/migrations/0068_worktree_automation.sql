-- Stage 3 follows 0066_worktrees and 0067_worktree_lifecycle.
-- Explicit child placement may use another owned worktree or the workspace checkout.
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
    IF parent.archived_at IS NOT NULL OR parent.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'parent thread % is unavailable', parent.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.project_id <> parent.project_id OR NEW.owner_user_id <> parent.owner_user_id
       OR NEW.root_thread_id <> parent.root_thread_id OR NEW.depth <> parent.depth + 1 THEN
      RAISE EXCEPTION 'side thread must share project, owner and tree with its parent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.runtime <> parent.runtime OR NEW.worker_id IS DISTINCT FROM parent.worker_id
       OR NEW.workspace_id IS DISTINCT FROM parent.workspace_id THEN
      RAISE EXCEPTION 'side thread must run in its parent workspace on the same worker' USING ERRCODE = 'check_violation';
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
    IF NEW.kind = 'main' AND (NEW.project_id <> source.project_id OR NEW.owner_user_id <> source.owner_user_id
       OR NEW.runtime <> source.runtime OR NEW.worker_id IS DISTINCT FROM source.worker_id) THEN
      RAISE EXCEPTION 'a forked main thread must share project, owner and worker with its source' USING ERRCODE = 'check_violation';
    END IF;
    IF source.provider <> NEW.provider THEN
      RAISE EXCEPTION 'fork must keep the provider (% -> %)', source.provider, NEW.provider USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.fork_after_turn_id IS NULL THEN
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

CREATE OR REPLACE FUNCTION threads_worktree_placement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tree worktrees%ROWTYPE;
  parent threads%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.worktree_id IS DISTINCT FROM OLD.worktree_id THEN
      RAISE EXCEPTION 'thread worktree placement is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.worktree_id IS NOT NULL THEN
    SELECT * INTO tree FROM worktrees WHERE id = NEW.worktree_id;
    IF NOT FOUND OR tree.removed_at IS NOT NULL OR NEW.runtime <> 'worker'
      OR (NEW.owner_user_id, NEW.project_id, NEW.workspace_id, NEW.worker_id, NEW.cwd)
         IS DISTINCT FROM (tree.owner_user_id, tree.project_id, tree.workspace_id, tree.worker_id, tree.path) THEN
      RAISE EXCEPTION 'thread must use its own workspace worktree and path' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.parent_thread_id IS NOT NULL THEN
    SELECT * INTO parent FROM threads WHERE id = NEW.parent_thread_id;
    IF NOT (parent.worktree_id IS NULL AND NEW.cwd IS NOT DISTINCT FROM parent.cwd)
       AND NEW.cwd IS DISTINCT FROM (SELECT root_path FROM project_workspaces WHERE id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'side thread must inherit placement or use the workspace checkout' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
