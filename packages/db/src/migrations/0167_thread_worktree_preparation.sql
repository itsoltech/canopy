ALTER TABLE threads ADD COLUMN preparation_fingerprint text;

ALTER TABLE threads DROP CONSTRAINT threads_runtime_placement;
ALTER TABLE threads ADD CONSTRAINT threads_runtime_placement CHECK (
  (runtime = 'worker' AND provider IN ('claude', 'codex', 'grok') AND worker_id IS NOT NULL AND workspace_id IS NOT NULL
    AND (cwd IS NOT NULL OR preparation_fingerprint IS NOT NULL))
  OR (runtime = 'gateway' AND provider IN ('anthropic', 'openai') AND worker_id IS NULL AND workspace_id IS NULL
    AND cwd IS NULL AND provider_profile_id IS NULL)
);
ALTER TABLE threads ADD CONSTRAINT threads_worktree_preparation CHECK (
  preparation_fingerprint IS NULL OR (
    preparation_fingerprint <> '' AND kind = 'main' AND runtime = 'worker' AND cwd IS NULL AND worktree_id IS NULL
    AND creation_request_id IS NOT NULL AND creation_request_id <> ''
    AND provider_thread_id IS NULL AND rewind_pending_id IS NULL AND status IN ('creating', 'failed', 'archived')
  )
);

-- Keep lineage and rewind rules while allowing an active reservation to acquire placement once.
CREATE OR REPLACE FUNCTION threads_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.rewind_pending_id IS NOT NULL AND (NEW.archived_at,NEW.deleted_at,NEW.moved_to)
      IS DISTINCT FROM (OLD.archived_at,OLD.deleted_at,OLD.moved_to) THEN
    RAISE EXCEPTION 'Wait for the thread to finish rewinding.' USING ERRCODE='check_violation';
  END IF;
  IF (NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
      NEW.runtime, NEW.provider, NEW.worker_id, NEW.workspace_id, NEW.fork_source_thread_id, NEW.fork_after_turn_id)
     IS DISTINCT FROM
     (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
      OLD.runtime, OLD.provider, OLD.worker_id, OLD.workspace_id, OLD.fork_source_thread_id, OLD.fork_after_turn_id)
     OR (OLD.preparation_fingerprint IS NOT NULL AND NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id) THEN
    RAISE EXCEPTION 'thread placement and lineage are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.cwd, NEW.worktree_id, NEW.preparation_fingerprint)
     IS DISTINCT FROM (OLD.cwd, OLD.worktree_id, OLD.preparation_fingerprint)
     AND NOT (
       OLD.preparation_fingerprint IS NOT NULL AND NEW.preparation_fingerprint IS NULL
       AND OLD.status = 'creating' AND OLD.archived_at IS NULL AND OLD.deleted_at IS NULL AND OLD.moved_to IS NULL
       AND OLD.provider_thread_id IS NULL AND OLD.rewind_pending_id IS NULL
       AND NEW.cwd IS NOT NULL AND NEW.worktree_id IS NOT NULL
       AND NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND NEW.moved_to IS NULL
       AND NEW.provider_thread_id IS NULL AND NEW.rewind_pending_id IS NULL
     ) THEN
    RAISE EXCEPTION 'thread worktree placement is immutable outside finalization' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id
     AND (NEW.provider_thread_id IS NULL OR EXISTS (
       SELECT 1 FROM turns WHERE thread_id=NEW.id AND started_at IS NOT NULL
         AND rewind_id IS NULL AND provider_session_id=OLD.provider_thread_id))
     AND NOT EXISTS (
       SELECT 1 FROM thread_rewinds r WHERE r.id=OLD.rewind_pending_id AND r.thread_id=OLD.id
         AND r.owner_user_id=OLD.owner_user_id
         AND ((r.status='completed' AND OLD.provider_thread_id=r.source_provider_thread_id
                AND NEW.provider_thread_id=r.replacement_provider_thread_id)
           OR (r.status='restored' AND OLD.provider_thread_id=r.replacement_provider_thread_id
                AND NEW.provider_thread_id=r.source_provider_thread_id))) THEN
    RAISE EXCEPTION 'provider session replacement requires a completed rewind' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION threads_worktree_placement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tree worktrees%ROWTYPE;
  parent threads%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.worktree_id IS NOT DISTINCT FROM OLD.worktree_id THEN RETURN NEW; END IF;
  ELSIF NEW.preparation_fingerprint IS NOT NULL
        AND (NEW.status <> 'creating' OR NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL
             OR NEW.moved_to IS NOT NULL) THEN
    RAISE EXCEPTION 'worktree preparation must begin on an active creating thread'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'threads_worktree_preparation';
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

-- Serialize finalization with removal and refresh last_used_at using the same gate as insertion.
CREATE TRIGGER worktree_available_thread_finalization BEFORE UPDATE ON threads
  FOR EACH ROW WHEN (OLD.preparation_fingerprint IS NOT NULL AND NEW.preparation_fingerprint IS NULL)
  EXECUTE FUNCTION worktree_require_available();

CREATE OR REPLACE FUNCTION thread_require_visible_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preparing boolean;
BEGIN
  IF NEW.parent_thread_id IS NOT NULL THEN
    SELECT preparation_fingerprint IS NOT NULL INTO preparing FROM threads
      WHERE id = NEW.parent_thread_id AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'parent thread is archived or deleted' USING ERRCODE = '23514'; END IF;
    IF preparing THEN
      RAISE EXCEPTION 'The parent thread is still preparing its worktree.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'thread_worktree_preparing';
    END IF;
  END IF;
  IF NEW.fork_source_thread_id IS NOT NULL THEN
    PERFORM id FROM threads WHERE id = NEW.fork_source_thread_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source thread not found' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Admission already locks the execution row for rewind, so it observes finalization under the same lock.
CREATE OR REPLACE FUNCTION turns_rewind_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; preparing boolean;
BEGIN
  SELECT rewind_pending_id, preparation_fingerprint IS NOT NULL INTO pending, preparing
    FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF preparing THEN
    RAISE EXCEPTION 'This thread is still preparing its worktree.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'thread_worktree_preparing';
  END IF;
  IF pending IS NOT NULL AND (TG_OP='INSERT' OR NEW.status='running') THEN
    RAISE EXCEPTION 'This thread is rewinding. Wait for it to finish.' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='INSERT' OR (NEW.started_at IS NOT NULL AND OLD.started_at IS NULL) THEN
    SELECT provider_thread_id INTO NEW.provider_session_id FROM threads WHERE id=NEW.thread_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION thread_work_rewind_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; preparing boolean;
BEGIN
  IF NEW.thread_id IS NULL THEN RETURN NEW; END IF;
  SELECT rewind_pending_id, preparation_fingerprint IS NOT NULL INTO pending, preparing
    FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF preparing THEN
    RAISE EXCEPTION 'This thread is still preparing its worktree.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'thread_worktree_preparing';
  END IF;
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is rewinding. Wait for it to finish.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
