-- Only a worker-confirmed, clean removal may supply its original RemoveWorktree command.
-- Existing removals lack this evidence and stay outside later branch cleanup.
ALTER TABLE worktrees ADD COLUMN branch_cleanup_source bytea;
ALTER TABLE worktrees ADD CONSTRAINT worktrees_branch_cleanup_source
  CHECK (branch_cleanup_source IS NULL OR (removed_at IS NOT NULL AND NOT external));

CREATE INDEX worktrees_removed_branch_cleanup ON worktrees (owner_user_id, worker_id, project_id)
  WHERE branch_cleanup_source IS NOT NULL;

-- Other threads can rely on the ref even in a different checkout (including as a stacked branch's base).
-- The reservation outlives a lost worker link; release it only when the command result is reconciled.
ALTER TABLE worktrees ADD COLUMN branch_cleanup_authorized boolean NOT NULL DEFAULT false
  CHECK (NOT branch_cleanup_authorized OR (removal_token IS NOT NULL AND removed_at IS NULL AND NOT external));
CREATE INDEX worktrees_branch_cleanup_in_flight ON worktrees (worker_id)
  WHERE removal_token IS NOT NULL AND (branch_cleanup_authorized OR branch_cleanup_source IS NOT NULL);

CREATE FUNCTION branch_cleanup_path_key(path text, os text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT rtrim(CASE os WHEN 'win32' THEN lower(replace(path,chr(92),'/'))
    WHEN 'darwin' THEN lower(path) ELSE path END,'/') || '/'
$$;

-- Same predicate for admitting deletion and admitting a new/restored thread while deletion is in flight.
CREATE FUNCTION worktree_branch_used_by(candidate worktrees, occupant threads) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT occupant.worker_id=candidate.worker_id AND CASE
    WHEN occupant.worktree_id=candidate.id THEN true
    WHEN occupant.worktree_id IS NOT NULL THEN EXISTS (
      -- Different workspace roots on one worker can share Git refs via linked checkouts.
      -- The worker checks live HEADs. For a recorded base we lack a common-dir identity, so keep ambiguous matches.
      SELECT 1 FROM worktrees wt WHERE wt.id=occupant.worktree_id AND (
        (wt.repo_root=candidate.repo_root AND wt.detached_commit='' AND wt.branch=candidate.branch) OR
        lower(wt.base_ref) IN (lower(candidate.branch),'refs/heads/' || lower(candidate.branch)) OR
        lower(regexp_replace(wt.base_ref,'^(refs/remotes/)?[^/]+/',''))=lower(candidate.branch)))
    ELSE EXISTS (
      SELECT 1 FROM project_workspaces ws JOIN workers worker ON worker.id=ws.worker_id
      LEFT JOIN checkout_heads ch ON ch.workspace_id=ws.id WHERE ws.id=occupant.workspace_id AND (
        starts_with(branch_cleanup_path_key(occupant.cwd,worker.os),branch_cleanup_path_key(candidate.path,worker.os)) OR
        (ch.branch=candidate.branch AND ch.detached_commit='' AND (ws.id=candidate.workspace_id OR
          starts_with(branch_cleanup_path_key(ws.root_path,worker.os),branch_cleanup_path_key(candidate.repo_root,worker.os)) OR
          EXISTS (SELECT 1 FROM worktrees wt WHERE wt.workspace_id=ws.id AND wt.repo_root=candidate.repo_root)))))
    END
$$;

CREATE FUNCTION branch_cleanup_admission_key(worker uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT hashtextextended('canopy.branch_cleanup:' || worker::text,0)
$$;

CREATE FUNCTION require_available_thread_branch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deleting_archived boolean := false;
BEGIN
  IF NEW.worker_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    deleting_archived := OLD.archived_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL;
  END IF;
  IF NOT deleting_archived AND (NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL) THEN RETURN NEW; END IF;

  -- Reservations try the exclusive lock without waiting. A new admission waits only for that short transaction.
  PERFORM pg_advisory_xact_lock_shared(branch_cleanup_admission_key(NEW.worker_id));
  IF EXISTS (SELECT 1 FROM worktrees w WHERE w.worker_id=NEW.worker_id AND w.removal_token IS NOT NULL
      AND (w.branch_cleanup_authorized OR w.branch_cleanup_source IS NOT NULL)
      AND CASE WHEN deleting_archived THEN NEW.worktree_id=w.id ELSE worktree_branch_used_by(w,NEW) END) THEN
    RAISE EXCEPTION 'Worktree cleanup is in progress. Wait for it to finish, then retry.'
      USING ERRCODE='check_violation', CONSTRAINT='worktree_branch_available';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER require_available_thread_branch
  AFTER INSERT OR UPDATE OF archived_at,deleted_at,cwd,worktree_id ON threads
  FOR EACH ROW EXECUTE FUNCTION require_available_thread_branch();
