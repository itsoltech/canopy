-- The live HEAD of thread checkouts (docs/worktrees.md, "Bieżąca gałąź"), as the worker reports it: the branch, or
-- the short commit of a detached HEAD (then branch is empty). worktrees.branch already holds a worktree's branch.
ALTER TABLE worktrees ADD COLUMN detached_commit text NOT NULL DEFAULT '';

-- The workspace's own checkout (threads without a worktree).
CREATE TABLE checkout_heads (
  workspace_id uuid PRIMARY KEY REFERENCES project_workspaces(id) ON DELETE CASCADE,
  branch text NOT NULL DEFAULT '',
  detached_commit text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
