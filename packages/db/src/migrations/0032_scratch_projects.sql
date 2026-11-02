-- System project keeps the existing owner, workspace, tree and schedule invariants.
ALTER TABLE projects ADD COLUMN kind text NOT NULL DEFAULT 'project'
  CHECK (kind IN ('project', 'scratch'));
CREATE UNIQUE INDEX projects_one_scratch_per_owner ON projects (owner_user_id)
  WHERE kind = 'scratch';

CREATE FUNCTION protect_scratch_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR
     (OLD.kind = 'scratch' AND (NEW.name IS DISTINCT FROM OLD.name OR
       NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.archived_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'system project identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_protect_scratch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION protect_scratch_project();
