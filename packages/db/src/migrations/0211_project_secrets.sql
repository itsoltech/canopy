ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'import_image_reply', 'render_visual', 'render_html',
  'watch_pr_checks', 'list_pr_watches', 'cancel_pr_watch', 'link_pull_request', 'message_delegating_bot',
  'find_canopy_settings', 'list_project_secrets'
)) NOT VALID;

CREATE TABLE project_secrets (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name COLLATE "C" ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  ciphertext bytea NOT NULL,
  key_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, name)
);

CREATE TABLE project_secret_leases (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  worker_epoch bigint NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '15 minutes'),
  revision integer NOT NULL DEFAULT 1,
  applied_revision integer NOT NULL DEFAULT 0,
  applied_epoch bigint,
  file_path text,
  last_delivery_at timestamptz,
  last_delivery_epoch bigint,
  last_delivery_revision integer,
  published_revision integer NOT NULL DEFAULT 0,
  CONSTRAINT project_secret_leases_turn FOREIGN KEY (turn_id, thread_id)
    REFERENCES turns(id, thread_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (status = 'saved' OR file_path IS NULL)
);

CREATE INDEX project_secret_leases_secret ON project_secret_leases(project_id, name) WHERE status = 'saved';
CREATE INDEX project_secret_leases_thread ON project_secret_leases(thread_id, created_at, id);
CREATE INDEX project_secret_leases_turn_scope ON project_secret_leases(turn_id, thread_id);
CREATE INDEX project_secret_leases_worker ON project_secret_leases(worker_id)
  WHERE status = 'saved' OR applied_revision < revision;
CREATE INDEX project_secret_leases_expiry ON project_secret_leases(owner_user_id, expires_at) WHERE status = 'saved';
CREATE INDEX project_secret_leases_publication ON project_secret_leases(owner_user_id, id)
  WHERE published_revision < revision;

-- Lease rows outlive the secret so a disconnected worker can receive a removal on reconnect.
CREATE FUNCTION revoke_changed_project_secret_leases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE project_secret_leases SET status = 'revoked', revision = revision + 1, file_path = NULL
    WHERE project_id = OLD.project_id AND name = OLD.name AND status = 'saved';
  RETURN OLD;
END;
$$;
CREATE TRIGGER project_secrets_revoke_leases AFTER UPDATE OR DELETE ON project_secrets
  FOR EACH ROW EXECUTE FUNCTION revoke_changed_project_secret_leases();

CREATE FUNCTION expire_project_secret_leases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'turns' THEN
    UPDATE project_secret_leases SET status = 'expired', revision = revision + 1, file_path = NULL
      WHERE turn_id = NEW.id AND status = 'saved';
  ELSIF TG_TABLE_NAME = 'threads' THEN
    UPDATE project_secret_leases SET status = 'expired', revision = revision + 1, file_path = NULL
      WHERE thread_id = NEW.id AND status = 'saved';
  ELSE
    UPDATE project_secret_leases SET status = 'expired', revision = revision + 1, file_path = NULL
      WHERE project_id = NEW.id AND status = 'saved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER turns_expire_project_secret_leases AFTER UPDATE OF status, rewind_id ON turns
  FOR EACH ROW WHEN (OLD.status = 'running' AND (NEW.status <> 'running' OR NEW.rewind_id IS NOT NULL))
  EXECUTE FUNCTION expire_project_secret_leases();

CREATE TRIGGER threads_expire_project_secret_leases
  AFTER UPDATE OF archived_at, deleted_at, moved_to, rewind_pending_id, worker_id, project_id, owner_user_id ON threads
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    OR (OLD.moved_to IS NULL AND NEW.moved_to IS NOT NULL)
    OR (OLD.rewind_pending_id IS NULL AND NEW.rewind_pending_id IS NOT NULL)
    OR OLD.worker_id IS DISTINCT FROM NEW.worker_id OR OLD.project_id <> NEW.project_id
    OR OLD.owner_user_id <> NEW.owner_user_id)
  EXECUTE FUNCTION expire_project_secret_leases();

CREATE TRIGGER projects_expire_project_secret_leases AFTER UPDATE OF archived_at, owner_user_id ON projects
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL) OR OLD.owner_user_id <> NEW.owner_user_id)
  EXECUTE FUNCTION expire_project_secret_leases();

-- Watches use the owner clock to recover control changes missed by their local Hub.
-- Keep the marker out of mirrored entities and retain no lease identifiers in it.
DROP TRIGGER thread_replication_change ON computer_thread_changes;
CREATE TRIGGER thread_replication_change AFTER INSERT ON computer_thread_changes
  FOR EACH ROW WHEN (NEW.entity_kind IS DISTINCT FROM 'thread_controls')
  EXECUTE FUNCTION thread_replication_changed();

CREATE FUNCTION project_secret_controls_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; owner uuid; rev bigint;
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.thread_id ELSE NEW.thread_id END;
  owner := CASE WHEN TG_OP='DELETE' THEN OLD.owner_user_id ELSE NEW.owner_user_id END;
  IF NOT EXISTS(SELECT 1 FROM threads WHERE id=target AND owner_user_id=owner AND deleted_at IS NULL) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0));
  INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
  UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
  INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind)
    VALUES(owner,rev,target,'thread_controls');
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER project_secret_controls_membership AFTER INSERT OR DELETE ON project_secret_leases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_secret_controls_changed();
CREATE CONSTRAINT TRIGGER project_secret_controls_metadata AFTER UPDATE ON project_secret_leases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.name,OLD.status,OLD.expires_at) IS DISTINCT FROM (NEW.name,NEW.status,NEW.expires_at))
  EXECUTE FUNCTION project_secret_controls_changed();
