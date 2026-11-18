-- One in-flight workspace placement per schedule. The occurrence survives a revoked scheduler lease.
CREATE TABLE schedule_worktree_preparations (
  schedule_id uuid PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  schedule_version integer NOT NULL,
  occurrence_at timestamptz NOT NULL,
  workspace_id uuid NOT NULL REFERENCES project_workspaces(id) ON DELETE CASCADE,
  worktree_id uuid NOT NULL,
  retry_after timestamptz NOT NULL
);
