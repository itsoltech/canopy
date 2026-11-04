-- Git worktrees (docs/worktrees.md). Settings live per owner in four scopes: all projects or one, across all
-- computers or one (NULL = all). Only the fields a scope overrides are stored; the gateway merges them over the
-- broader scopes and its built-in defaults.
CREATE TABLE worktree_settings (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  worker_id uuid REFERENCES workers(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX worktree_settings_scope ON worktree_settings (owner_user_id, project_id, worker_id) NULLS NOT DISTINCT;

-- A worktree a thread works in, on the worker that has the repository. Several threads may share one (side
-- threads, forks, "Previous worktree"). The branch can change once (a generated name); the path never does.
CREATE TABLE worktrees (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  repo_root text NOT NULL,
  path text NOT NULL CHECK (path <> ''),
  branch text NOT NULL CHECK (branch <> ''),
  base_ref text NOT NULL DEFAULT '',
  base_commit text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX worktrees_live_path ON worktrees (worker_id, path) WHERE removed_at IS NULL;
CREATE INDEX worktrees_recent ON worktrees (owner_user_id, project_id, worker_id, last_used_at DESC) WHERE removed_at IS NULL;

-- NULL = the workspace's own checkout. The thread's cwd is the worktree's path (placement stays immutable).
ALTER TABLE threads ADD COLUMN worktree_id uuid REFERENCES worktrees(id);
CREATE INDEX threads_worktree ON threads (worktree_id) WHERE worktree_id IS NOT NULL;

-- Worktree identity is part of placement, just like cwd. Removed worktrees remain for thread history.
CREATE FUNCTION threads_worktree_placement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tree worktrees%ROWTYPE;
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
  END IF;
  IF NEW.parent_thread_id IS NOT NULL AND NEW.worktree_id IS DISTINCT FROM
     (SELECT worktree_id FROM threads WHERE id = NEW.parent_thread_id) THEN
    RAISE EXCEPTION 'side thread must inherit its parent worktree' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER threads_worktree_placement BEFORE INSERT OR UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION threads_worktree_placement();
