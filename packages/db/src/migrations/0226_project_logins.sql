-- Project logins (docs/secrets.md#loginy-projektu). A separate table, so a gateway that predates logins can
-- neither list, lease, deliver nor overwrite one. `login` holds what the agent may read; the password and the
-- one-time code setup key stay in the ciphertext.
CREATE TABLE project_logins (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name COLLATE "C" ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  ciphertext bytea NOT NULL,
  key_id text NOT NULL,
  login jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, name)
);

-- Secrets and logins share one namespace per project, also against a gateway that predates logins.
CREATE FUNCTION project_credential_name_free() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.project_credential:' || NEW.project_id || '/' || NEW.name, 0));
  IF TG_TABLE_NAME = 'project_secrets'
    AND EXISTS(SELECT 1 FROM project_logins WHERE project_id = NEW.project_id AND name = NEW.name) THEN
    RAISE EXCEPTION 'a project login already uses this name' USING ERRCODE = 'unique_violation';
  ELSIF TG_TABLE_NAME = 'project_logins'
    AND EXISTS(SELECT 1 FROM project_secrets WHERE project_id = NEW.project_id AND name = NEW.name) THEN
    RAISE EXCEPTION 'a project secret already uses this name' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_secrets_name_free BEFORE INSERT OR UPDATE OF name ON project_secrets
  FOR EACH ROW EXECUTE FUNCTION project_credential_name_free();
CREATE TRIGGER project_logins_name_free BEFORE INSERT OR UPDATE OF name ON project_logins
  FOR EACH ROW EXECUTE FUNCTION project_credential_name_free();

-- `login` leases read project_logins. `memory_only` keeps the value in worker memory for Agent Browser,
-- for the browser action `admission` (an admitted local automation call) that asked for it.
ALTER TABLE project_secret_leases
  ADD COLUMN login boolean NOT NULL DEFAULT false,
  ADD COLUMN memory_only boolean NOT NULL DEFAULT false,
  ADD COLUMN origin text CHECK (origin IS NULL OR length(origin) <= 2048),
  ADD COLUMN admission text CHECK (admission IS NULL OR length(admission) <= 128),
  ADD CONSTRAINT project_secret_leases_memory_login CHECK (login OR NOT memory_only);

CREATE FUNCTION revoke_changed_project_login_leases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE project_secret_leases SET status = 'revoked', revision = revision + 1, file_path = NULL
    WHERE project_id = OLD.project_id AND name = OLD.name AND login AND status = 'saved';
  UPDATE project_login_decisions SET status = 'revoked', revision = revision + 1
    WHERE project_id = OLD.project_id AND name = OLD.name AND status IN ('pending', 'allowed');
  RETURN OLD;
END;
$$;

-- The owner's answer for a login that asks each time: one per turn, login and kind of access. Leases come
-- and go with worker connections; this decision holds for the whole turn.
CREATE TABLE project_login_decisions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  name text NOT NULL,
  access text NOT NULL CHECK (access IN ('browser', 'file')),
  origin text CHECK (origin IS NULL OR length(origin) <= 2048),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'declined', 'expired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revision integer NOT NULL DEFAULT 1,
  published_revision integer NOT NULL DEFAULT 0,
  CONSTRAINT project_login_decisions_turn FOREIGN KEY (turn_id, thread_id)
    REFERENCES turns(id, thread_id) ON DELETE CASCADE,
  UNIQUE (turn_id, name, access)
);

CREATE INDEX project_login_decisions_thread ON project_login_decisions(thread_id, created_at, id);
CREATE INDEX project_login_decisions_login ON project_login_decisions(project_id, name)
  WHERE status IN ('pending', 'allowed');
CREATE INDEX project_login_decisions_publication ON project_login_decisions(owner_user_id, id)
  WHERE published_revision < revision;

CREATE TRIGGER project_logins_revoke_leases AFTER UPDATE OR DELETE ON project_logins
  FOR EACH ROW EXECUTE FUNCTION revoke_changed_project_login_leases();

CREATE FUNCTION expire_project_login_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'turns' THEN
    UPDATE project_login_decisions SET status = 'expired', revision = revision + 1
      WHERE turn_id = NEW.id AND status IN ('pending', 'allowed');
  ELSIF TG_TABLE_NAME = 'threads' THEN
    UPDATE project_login_decisions SET status = 'expired', revision = revision + 1
      WHERE thread_id = NEW.id AND status IN ('pending', 'allowed');
  ELSE
    UPDATE project_login_decisions SET status = 'expired', revision = revision + 1
      WHERE project_id = NEW.id AND status IN ('pending', 'allowed');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turns_expire_project_login_decisions AFTER UPDATE OF status, rewind_id ON turns
  FOR EACH ROW WHEN (OLD.status = 'running' AND (NEW.status <> 'running' OR NEW.rewind_id IS NOT NULL))
  EXECUTE FUNCTION expire_project_login_decisions();

CREATE TRIGGER threads_expire_project_login_decisions
  AFTER UPDATE OF archived_at, deleted_at, moved_to, rewind_pending_id, worker_id, project_id, owner_user_id ON threads
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    OR (OLD.moved_to IS NULL AND NEW.moved_to IS NOT NULL)
    OR (OLD.rewind_pending_id IS NULL AND NEW.rewind_pending_id IS NOT NULL)
    OR OLD.project_id <> NEW.project_id OR OLD.owner_user_id <> NEW.owner_user_id)
  EXECUTE FUNCTION expire_project_login_decisions();

CREATE TRIGGER projects_expire_project_login_decisions AFTER UPDATE OF archived_at, owner_user_id ON projects
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL) OR OLD.owner_user_id <> NEW.owner_user_id)
  EXECUTE FUNCTION expire_project_login_decisions();

-- Linked computers mirror the thread's controls when a decision appears or changes.
CREATE CONSTRAINT TRIGGER project_login_decision_controls_membership
  AFTER INSERT OR DELETE ON project_login_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_secret_controls_changed();
CREATE CONSTRAINT TRIGGER project_login_decision_controls_metadata AFTER UPDATE ON project_login_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.name, OLD.status) IS DISTINCT FROM (NEW.name, NEW.status))
  EXECUTE FUNCTION project_secret_controls_changed();
