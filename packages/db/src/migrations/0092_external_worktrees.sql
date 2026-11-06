-- Discovery stays read-only. A thread's first use registers an external worktree permanently.
ALTER TABLE worktrees ADD COLUMN external boolean NOT NULL DEFAULT false;
ALTER TABLE worktrees DROP CONSTRAINT worktrees_branch_check;
ALTER TABLE worktrees ADD CONSTRAINT worktrees_branch_check CHECK (branch <> '' OR external);

CREATE FUNCTION protect_external_worktree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.external AND (NOT NEW.external OR NEW.path IS DISTINCT FROM OLD.path
    OR NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removal_token IS NOT NULL
    OR NEW.branch_source = 'provisional') THEN
    RAISE EXCEPTION 'external worktrees are read-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_external_worktree BEFORE UPDATE ON worktrees
  FOR EACH ROW EXECUTE FUNCTION protect_external_worktree();
