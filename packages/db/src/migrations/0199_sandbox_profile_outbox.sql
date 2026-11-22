ALTER TABLE worker_commands ADD COLUMN sandbox_digest text;

CREATE FUNCTION check_sandbox_profile_command() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  binding jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status <> 'delivered' THEN
    RETURN NEW;
  END IF;
  IF NEW.thread_id IS NULL OR NEW.kind NOT IN
      ('createThread', 'startTurn', 'steerTurn', 'setGoal', 'rewindThread', 'updateTurnPermissions') THEN
    RETURN NEW;
  END IF;

  SELECT settings->'sandboxProfile' INTO binding FROM threads WHERE id = NEW.thread_id FOR SHARE;

  IF binding IS NOT NULL AND binding <> 'null'::jsonb AND (
       NEW.kind NOT IN ('createThread', 'startTurn')
       OR NEW.sandbox_digest IS NULL
       OR NEW.sandbox_digest IS DISTINCT FROM binding->>'digest'
     ) THEN
    RAISE EXCEPTION 'This command cannot run with the selected sandbox profile.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- An older gateway cannot replace a persisted policy with an ordinary provider invocation after rollback.
CREATE TRIGGER worker_command_sandbox_profile
  BEFORE INSERT OR UPDATE OF status ON worker_commands
  FOR EACH ROW EXECUTE FUNCTION check_sandbox_profile_command();

CREATE FUNCTION check_sandbox_profile_derivation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  binding jsonb;
  scheduled jsonb;
BEGIN
  IF NEW.schedule_id IS NOT NULL THEN
    SELECT new_thread INTO scheduled FROM schedules WHERE id = NEW.schedule_id;
    binding := scheduled->'sandboxProfile';

    IF binding IS NOT NULL AND binding <> 'null'::jsonb
        AND binding IS DISTINCT FROM NEW.settings->'sandboxProfile' THEN
      RAISE EXCEPTION 'This schedule cannot create a thread without its sandbox profile.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM threads
      WHERE id::text = scheduled->>'parentThreadId'
        AND settings->'sandboxProfile' IS NOT NULL AND settings->'sandboxProfile' <> 'null'::jsonb
        AND settings->'sandboxProfile' IS DISTINCT FROM NEW.settings->'sandboxProfile'
    ) THEN
      RAISE EXCEPTION 'This schedule cannot derive a thread without preserving the parent sandbox profile.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM threads
      WHERE id IN (NEW.parent_thread_id, NEW.fork_source_thread_id)
        AND settings->'sandboxProfile' IS NOT NULL
        AND settings->'sandboxProfile' <> 'null'::jsonb
        AND settings->'sandboxProfile' IS DISTINCT FROM NEW.settings->'sandboxProfile'
    ) THEN
      RAISE EXCEPTION 'This thread cannot be derived without preserving its sandbox profile.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.creation_request_id LIKE 'worktree-continuation:%' AND EXISTS (
      SELECT 1 FROM threads
      WHERE id::text = split_part(NEW.creation_request_id, ':', 2)
        AND owner_user_id = NEW.owner_user_id
        AND settings->'sandboxProfile' IS NOT NULL AND settings->'sandboxProfile' <> 'null'::jsonb
        AND settings->'sandboxProfile' IS DISTINCT FROM NEW.settings->'sandboxProfile'
    ) THEN
      RAISE EXCEPTION 'This worktree continuation must preserve its source sandbox profile.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  binding := OLD.settings->'sandboxProfile';

  IF NEW.moved_to IS NOT NULL AND NEW.moved_to IS DISTINCT FROM OLD.moved_to
      AND binding IS NOT NULL AND binding <> 'null'::jsonb THEN
    RAISE EXCEPTION 'This thread cannot move while a sandbox profile is selected.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER thread_sandbox_profile_derivation
  BEFORE INSERT OR UPDATE OF moved_to, schedule_id ON threads
  FOR EACH ROW EXECUTE FUNCTION check_sandbox_profile_derivation();

CREATE FUNCTION check_sandbox_profile_schedule_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  binding jsonb := OLD.new_thread->'sandboxProfile';
BEGIN
  IF binding IS NOT NULL AND binding <> 'null'::jsonb
      AND binding IS DISTINCT FROM NEW.new_thread->'sandboxProfile'
      AND current_setting('canopy.sandbox_profile_schedule_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Updating the scheduled sandbox profile requires a compatible gateway.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_sandbox_profile_update
  BEFORE UPDATE OF new_thread ON schedules
  FOR EACH ROW EXECUTE FUNCTION check_sandbox_profile_schedule_update();

CREATE FUNCTION check_sandbox_profile_linked_spawn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction = 'outgoing' AND NEW.actor_kind = 'thread' AND NEW.operation = 'spawn'
      AND EXISTS (
        SELECT 1 FROM threads WHERE id = NEW.actor_id AND owner_user_id = NEW.owner_user_id
          AND settings->'sandboxProfile' IS NOT NULL AND settings->'sandboxProfile' <> 'null'::jsonb
      ) THEN
    RAISE EXCEPTION 'This thread cannot spawn across computers while a sandbox profile is selected.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER linked_spawn_sandbox_profile
  BEFORE INSERT ON computer_agent_calls
  FOR EACH ROW EXECUTE FUNCTION check_sandbox_profile_linked_spawn();

ALTER TABLE composer_drafts ADD COLUMN sandbox_profile_selected boolean NOT NULL DEFAULT false;

CREATE FUNCTION check_sandbox_profile_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sandbox_profile_selected AND NOT OLD.sent AND (
      (NEW.sending_request_id IS NOT NULL AND octet_length(NEW.send_request) IS DISTINCT FROM 64)
      OR (NOT NEW.sent AND (
        OLD.payload IS DISTINCT FROM NEW.payload
        OR OLD.sandbox_profile_selected IS DISTINCT FROM NEW.sandbox_profile_selected
      ) AND current_setting('canopy.sandbox_profile_draft_write', true) IS DISTINCT FROM '1')
    ) THEN
    RAISE EXCEPTION 'Updating or sending the draft with its sandbox profile requires a compatible gateway.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER composer_draft_sandbox_profile
  BEFORE UPDATE OF payload, sandbox_profile_selected, sending_request_id, send_request ON composer_drafts
  FOR EACH ROW EXECUTE FUNCTION check_sandbox_profile_draft();
