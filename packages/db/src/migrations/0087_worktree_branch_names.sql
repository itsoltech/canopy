-- Generated branch names (docs/worktrees.md, "Nazwy gałęzi"). A SEMANTIC worktree starts on a provisional name
-- that the gateway may rename once the task is clear: after creation and after the next turns, a limited number of
-- times. generated = renamed by Canopy; kept = the rename was skipped for good (pushed, switched, renamed by hand);
-- fixed = the name was final from the start (PREFIX, TITLE, worktrees made before this migration).
ALTER TABLE worktrees ADD COLUMN branch_source text NOT NULL DEFAULT 'fixed'
  CHECK (branch_source IN ('provisional', 'generated', 'kept', 'fixed'));
ALTER TABLE worktrees ADD COLUMN branch_attempts smallint NOT NULL DEFAULT 0;
-- The name the worktree was created with; a provisional branch is renamed only while HEAD is still on it.
ALTER TABLE worktrees ADD COLUMN provisional_branch text NOT NULL DEFAULT '';
