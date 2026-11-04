-- Persist the creation root: changing settings must not strand earlier worktrees.
ALTER TABLE worktrees ADD COLUMN location text NOT NULL DEFAULT '';
ALTER TABLE worktrees ADD COLUMN removal_token uuid;
ALTER TABLE worktrees ADD COLUMN removal_started_at timestamptz;
ALTER TABLE worktrees ADD COLUMN removal_command bytea;

-- Backfill configured roots for stage-1 trees. Managed roots remain empty (worker's data directory).
UPDATE worktrees w SET location = coalesce(
  (SELECT settings->>'location' FROM worktree_settings s
    WHERE s.owner_user_id = w.owner_user_id
      AND (s.project_id IS NULL OR s.project_id = w.project_id)
      AND (s.worker_id IS NULL OR s.worker_id = w.worker_id)
      AND settings ? 'location'
    ORDER BY (s.project_id IS NOT NULL) DESC, (s.worker_id IS NOT NULL) DESC LIMIT 1), '');

-- Serialize new threads/turns with removal. History remains readable after the filesystem is removed.
CREATE FUNCTION worktree_require_available() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; tree worktrees%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'threads' THEN
    wid := NEW.worktree_id;
  ELSIF TG_TABLE_NAME = 'goals' THEN
    IF NEW.status IN ('achieved', 'cancelled') THEN RETURN NEW; END IF;
    SELECT worktree_id INTO wid FROM threads WHERE id = NEW.thread_id;
  ELSE
    IF NEW.status NOT IN ('queued', 'running') THEN RETURN NEW; END IF;
    SELECT worktree_id INTO wid FROM threads WHERE id = NEW.thread_id;
  END IF;
  IF wid IS NOT NULL THEN
    SELECT * INTO tree FROM worktrees WHERE id = wid FOR UPDATE;
    IF tree.removed_at IS NOT NULL OR tree.removal_token IS NOT NULL THEN
      RAISE EXCEPTION 'worktree removed or cleanup in progress' USING ERRCODE = 'check_violation', CONSTRAINT = 'worktree_available';
    END IF;
    UPDATE worktrees SET last_used_at = now() WHERE id = wid;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worktree_available_thread BEFORE INSERT ON threads
  FOR EACH ROW EXECUTE FUNCTION worktree_require_available();
CREATE TRIGGER worktree_available_turn BEFORE INSERT OR UPDATE OF status ON turns
  FOR EACH ROW EXECUTE FUNCTION worktree_require_available();
CREATE TRIGGER worktree_available_goal BEFORE INSERT OR UPDATE OF status ON goals
  FOR EACH ROW EXECUTE FUNCTION worktree_require_available();
