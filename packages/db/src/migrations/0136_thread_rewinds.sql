-- Rewinds preserve both transcript evidence and the original harness session.
CREATE TABLE thread_rewinds (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  turn_id uuid NOT NULL REFERENCES turns(id),
  client_request_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','restoring','restored')),
  source_provider_thread_id text NOT NULL,
  replacement_provider_thread_id text,
  command_id uuid NOT NULL,
  restore_files boolean NOT NULL DEFAULT false,
  draft jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_seq bigint,
  restored_seq bigint,
  UNIQUE(thread_id,client_request_id)
);
CREATE UNIQUE INDEX thread_rewinds_one_pending ON thread_rewinds(thread_id)
  WHERE status IN ('pending','restoring');
ALTER TABLE threads ADD COLUMN rewind_pending_id uuid REFERENCES thread_rewinds(id);
ALTER TABLE turns ADD COLUMN rewind_id uuid REFERENCES thread_rewinds(id);
-- Claude forks remap message UUIDs: preserve each boundary's original session.
ALTER TABLE turns ADD COLUMN provider_session_id text;
UPDATE turns u SET provider_session_id=t.provider_thread_id FROM threads t WHERE t.id=u.thread_id;
CREATE TABLE thread_rewind_turns (
  rewind_id uuid NOT NULL REFERENCES thread_rewinds(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  PRIMARY KEY(rewind_id,turn_id)
);
CREATE INDEX thread_rewind_turns_turn ON thread_rewind_turns(turn_id);
-- A fork freezes the visible prefix at its source seq, including rewinds and their undo.
CREATE FUNCTION thread_turn_visible_at(target uuid, cutoff bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT cutoff IS NULL OR NOT EXISTS (
    SELECT 1 FROM thread_rewind_turns m JOIN thread_rewinds r ON r.id=m.rewind_id
    WHERE m.turn_id=target AND r.completed_seq<=cutoff AND (r.restored_seq IS NULL OR r.restored_seq>cutoff)
  )
$$;

CREATE OR REPLACE FUNCTION threads_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.rewind_pending_id IS NOT NULL AND (NEW.archived_at,NEW.deleted_at,NEW.moved_to)
      IS DISTINCT FROM (OLD.archived_at,OLD.deleted_at,OLD.moved_to) THEN
    RAISE EXCEPTION 'Wait for the thread to finish rewinding.' USING ERRCODE='check_violation';
  END IF;
  IF (NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
      NEW.runtime, NEW.provider, NEW.worker_id, NEW.workspace_id, NEW.cwd,
      NEW.fork_source_thread_id, NEW.fork_after_turn_id)
     IS DISTINCT FROM
     (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
      OLD.runtime, OLD.provider, OLD.worker_id, OLD.workspace_id, OLD.cwd,
      OLD.fork_source_thread_id, OLD.fork_after_turn_id) THEN
    RAISE EXCEPTION 'thread placement and lineage are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id
     AND (NEW.provider_thread_id IS NULL OR EXISTS (
       SELECT 1 FROM turns WHERE thread_id=NEW.id AND started_at IS NOT NULL
         AND rewind_id IS NULL AND provider_session_id=OLD.provider_thread_id))
     AND NOT EXISTS (
       SELECT 1 FROM thread_rewinds r WHERE r.id=OLD.rewind_pending_id AND r.thread_id=OLD.id
         AND r.owner_user_id=OLD.owner_user_id
         AND ((r.status='completed' AND OLD.provider_thread_id=r.source_provider_thread_id
                AND NEW.provider_thread_id=r.replacement_provider_thread_id)
           OR (r.status='restored' AND OLD.provider_thread_id=r.replacement_provider_thread_id
                AND NEW.provider_thread_id=r.source_provider_thread_id))) THEN
    RAISE EXCEPTION 'provider session replacement requires a completed rewind' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Fence every producer under the same lock, including schedules and agent-bus inputs.
CREATE FUNCTION turns_rewind_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  SELECT rewind_pending_id INTO pending FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF pending IS NOT NULL AND (TG_OP='INSERT' OR NEW.status='running') THEN
    RAISE EXCEPTION 'This thread is rewinding. Wait for it to finish.' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='INSERT' OR (NEW.started_at IS NOT NULL AND OLD.started_at IS NULL) THEN
    SELECT provider_thread_id INTO NEW.provider_session_id FROM threads WHERE id=NEW.thread_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER turns_rewind_admission BEFORE INSERT OR UPDATE OF status,started_at ON turns
  FOR EACH ROW EXECUTE FUNCTION turns_rewind_admission();

-- These producers can race UI requests. Serialize their writes with rewind admission.
CREATE FUNCTION thread_work_rewind_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF NEW.thread_id IS NULL THEN RETURN NEW; END IF;
  SELECT rewind_pending_id INTO pending FROM threads WHERE id=NEW.thread_id FOR UPDATE;
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'This thread is rewinding. Wait for it to finish.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goals_rewind_admission BEFORE INSERT OR UPDATE OF status ON goals
  FOR EACH ROW EXECUTE FUNCTION thread_work_rewind_admission();
CREATE TRIGGER schedules_rewind_admission BEFORE INSERT OR UPDATE OF status ON schedules
  FOR EACH ROW EXECUTE FUNCTION thread_work_rewind_admission();
CREATE TRIGGER steers_rewind_admission BEFORE INSERT ON turn_steers
  FOR EACH ROW EXECUTE FUNCTION thread_work_rewind_admission();

-- Mutation and call receipt share a transaction; late calls roll back their effects.
CREATE FUNCTION agent_call_rewind_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF NEW.status='failed' THEN RETURN NEW; END IF;
  SELECT rewind_pending_id INTO pending FROM threads WHERE id=NEW.source_thread_id FOR UPDATE;
  IF pending IS NOT NULL OR EXISTS (SELECT 1 FROM turns WHERE id=NEW.source_turn_id AND rewind_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This message has been rewound.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_calls_rewind_admission BEFORE INSERT ON agent_bus_calls
  FOR EACH ROW EXECUTE FUNCTION agent_call_rewind_admission();

CREATE FUNCTION threads_rewind_fork_point() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid;
BEGIN
  IF NEW.fork_source_thread_id IS NULL THEN RETURN NEW; END IF;
  SELECT rewind_pending_id INTO pending FROM threads WHERE id=NEW.fork_source_thread_id FOR SHARE;
  IF pending IS NOT NULL THEN RAISE EXCEPTION 'Wait for the thread to finish rewinding.' USING ERRCODE='check_violation'; END IF;
  IF NEW.fork_after_turn_id IS NULL THEN
    SELECT id INTO NEW.fork_after_turn_id FROM turns WHERE thread_id=NEW.fork_source_thread_id
      AND status='completed' AND rewind_id IS NULL ORDER BY ordinal DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'The source has no completed visible turn.' USING ERRCODE='check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER threads_00_rewind_fork_point BEFORE INSERT ON threads
  FOR EACH ROW EXECUTE FUNCTION threads_rewind_fork_point();

CREATE OR REPLACE FUNCTION thread_items_view(p_thread_id uuid)
RETURNS TABLE (thread_id uuid, item_id text, turn_id uuid, parent_item_id text, type text, status text,
               content jsonb, first_seq bigint, last_seq bigint, inherited boolean, changed_after_fork boolean)
LANGUAGE sql STABLE AS $$
  SELECT i.thread_id,i.item_id,i.turn_id,i.parent_item_id,i.type,i.status,i.content,i.first_seq,i.last_seq,
    c.level>0,c.upto_seq IS NOT NULL AND i.last_seq>c.upto_seq
  FROM thread_fork_chain(p_thread_id) c JOIN thread_items i ON i.thread_id=c.thread_id
  WHERE (c.upto_seq IS NULL OR i.first_seq<=c.upto_seq) AND thread_turn_visible_at(i.turn_id,c.upto_seq)
  ORDER BY c.level DESC,i.first_seq
$$;
