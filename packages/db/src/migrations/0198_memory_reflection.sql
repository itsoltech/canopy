CREATE TABLE memory_reflection_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes IN (360,720,1440,4320,10080)),
  project_ids uuid[] NOT NULL DEFAULT '{}',
  worker_id uuid REFERENCES workers(id),
  provider integer NOT NULL DEFAULT 0 CHECK (provider BETWEEN 0 AND 3),
  profile_id text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  effort text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_state text NOT NULL DEFAULT '',
  history_start timestamptz,
  last_attempt_at timestamptz,
  last_project_id uuid
);

-- An off/on cycle cannot replenish a spent period. Changing frequency applies the new interval.
CREATE FUNCTION memory_reflection_schedule_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NEW.next_run_at IS NOT NULL AND NEW.last_attempt_at IS NOT NULL THEN
    NEW.next_run_at := greatest(NEW.next_run_at,NEW.last_attempt_at+make_interval(mins=>NEW.interval_minutes));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_reflection_budget BEFORE INSERT OR UPDATE OF enabled,interval_minutes,next_run_at ON memory_reflection_settings
  FOR EACH ROW EXECUTE FUNCTION memory_reflection_schedule_budget();

CREATE TABLE memory_reflection_runs (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  settings_revision integer NOT NULL,
  created_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('running','unknown','completed','failed','invalid','superseded')),
  UNIQUE(owner_user_id,id)
);
CREATE INDEX memory_reflection_runs_owner ON memory_reflection_runs(owner_user_id, created_at DESC);
CREATE UNIQUE INDEX memory_reflection_one_run ON memory_reflection_runs(owner_user_id) WHERE state='running';

-- The native input is the durable queue. These small partial indexes also cover a newly enabled project.
CREATE INDEX memory_reflection_user_turns ON turns(thread_id,queued_at,id)
  WHERE trigger='user' AND input @> '{"humanAuthored":true}' AND rewind_id IS NULL AND withdrawn IS NULL;
CREATE INDEX memory_reflection_user_steers ON turn_steers(thread_id,created_at,id)
  WHERE status='delivered' AND input @> '{"humanAuthored":true}';

CREATE VIEW memory_reflection_inputs AS
SELECT u.id AS message_id,u.thread_id,u.id AS turn_id,NULL::uuid AS steer_id,u.queued_at AS created_at,
       u.author_user_id,u.input
FROM turns u WHERE u.trigger='user' AND u.input @> '{"humanAuthored":true}' AND u.started_at IS NOT NULL
  AND u.rewind_id IS NULL AND u.withdrawn IS NULL AND u.status IN ('completed','interrupted','failed')
UNION ALL
SELECT s.id,s.thread_id,s.turn_id,s.id,s.created_at,s.author_user_id,s.input
FROM turn_steers s JOIN turns u ON u.id=s.turn_id AND u.thread_id=s.thread_id
WHERE s.status='delivered' AND s.delivered_seq IS NOT NULL AND s.author_user_id IS NOT NULL
  AND s.input @> '{"humanAuthored":true}' AND u.rewind_id IS NULL AND u.withdrawn IS NULL;

-- A receipt carries identifiers, never a copy of the source. Uncertain sends retain their receipts.
CREATE TABLE memory_reflection_checked (
  message_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  steer_id uuid REFERENCES turn_steers(id) ON DELETE CASCADE,
  run_id uuid,
  CHECK (message_id=coalesce(steer_id,turn_id)),
  FOREIGN KEY (owner_user_id,thread_id) REFERENCES threads(owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id,thread_id) REFERENCES turns(id,thread_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id,run_id) REFERENCES memory_reflection_runs(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX memory_reflection_checked_turn ON memory_reflection_checked(turn_id);
CREATE INDEX memory_reflection_checked_thread ON memory_reflection_checked(thread_id);
CREATE INDEX memory_reflection_checked_run ON memory_reflection_checked(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE memory_habits (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  habit_key text NOT NULL,
  reversed_at timestamptz,
  rule text NOT NULL,
  state text NOT NULL CHECK (state IN ('observing','pending','approved','rejected','suspended')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  note_id uuid UNIQUE REFERENCES agent_memory_notes(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,habit_key)
);

CREATE TABLE memory_habit_evidence (
  habit_id uuid NOT NULL REFERENCES memory_habits(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES memory_reflection_checked(message_id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(habit_id,message_id)
);
CREATE INDEX memory_habit_evidence_message ON memory_habit_evidence(message_id);

CREATE TABLE memory_habit_thread_contexts (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL,
  rules jsonb NOT NULL,
  revoked_turn_id uuid
);

-- Hide evidence immediately. Receipts survive rewind/restore, including a lost generation ACK.
CREATE FUNCTION memory_reflection_forget_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_habit_evidence WHERE thread_id=NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER memory_reflection_thread_hidden AFTER UPDATE OF deleted_at,purged_at,moved_to,memory_audience ON threads
  FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL OR NEW.purged_at IS NOT NULL OR
                     NEW.moved_to IS NOT NULL OR NEW.memory_audience<>'') EXECUTE FUNCTION memory_reflection_forget_thread();

CREATE FUNCTION memory_reflection_forget_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_habit_evidence WHERE message_id IN (SELECT message_id FROM memory_reflection_checked WHERE turn_id=NEW.id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER memory_reflection_turn_hidden AFTER UPDATE OF rewind_id,withdrawn ON turns
  FOR EACH ROW WHEN (NEW.rewind_id IS NOT NULL OR NEW.withdrawn IS NOT NULL) EXECUTE FUNCTION memory_reflection_forget_turn();

CREATE FUNCTION memory_reflection_forget_steer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory_habit_evidence WHERE message_id=NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER memory_reflection_steer_hidden AFTER UPDATE OF status ON turn_steers
  FOR EACH ROW WHEN (OLD.status='delivered' AND NEW.status<>'delivered') EXECUTE FUNCTION memory_reflection_forget_steer();

CREATE FUNCTION memory_habit_lost_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE memory_habits SET state='observing',revision=revision+1,updated_at=now()
    WHERE id=OLD.habit_id AND state='pending' AND NOT EXISTS (
      SELECT 1 FROM memory_habit_evidence WHERE habit_id=OLD.habit_id AND created_at>=now()-interval '60 days'
      HAVING count(DISTINCT thread_id)>=3 AND count(DISTINCT family_id)>=2);
  RETURN NULL;
END;
$$;
CREATE TRIGGER memory_habit_evidence_removed AFTER DELETE ON memory_habit_evidence
  FOR EACH ROW EXECUTE FUNCTION memory_habit_lost_evidence();
