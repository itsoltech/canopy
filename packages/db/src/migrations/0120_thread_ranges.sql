-- The journal includes public entity invalidations, not execution rows or secrets.
-- Allocating a number and recording the invalidation are part of the source commit.
-- A publisher seals its bounded public projection before that number can be sent.
CREATE TABLE thread_replication_clock (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  head_seq bigint NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  change_version bigint NOT NULL DEFAULT 0,
  legacy_ready boolean NOT NULL DEFAULT false
);
CREATE TABLE thread_replication_seed_entities (
  thread_id uuid NOT NULL REFERENCES thread_replication_clock(thread_id) ON DELETE CASCADE,
  kind text NOT NULL,
  entity_id text NOT NULL,
  payload bytea NOT NULL,
  PRIMARY KEY(thread_id,kind,entity_id)
);
CREATE INDEX thread_replication_owner ON thread_replication_clock(owner_user_id,thread_id);
CREATE TABLE thread_replication_journal (
  thread_id uuid NOT NULL REFERENCES thread_replication_clock(thread_id) ON DELETE CASCADE,
  epoch uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  kind text NOT NULL,
  entity_id text NOT NULL,
  payload bytea,
  PRIMARY KEY(thread_id,epoch,seq)
);
-- Unpublished changes of one entity coalesce. Published records are immutable.
CREATE UNIQUE INDEX thread_replication_pending ON thread_replication_journal(thread_id,epoch,kind,entity_id)
  WHERE payload IS NULL;
CREATE TABLE thread_replication_content (
  thread_id uuid NOT NULL REFERENCES thread_replication_clock(thread_id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  data bytea NOT NULL,
  PRIMARY KEY(thread_id,sha256)
);
CREATE TABLE thread_range_state (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  thread_id uuid NOT NULL,
  epoch uuid NOT NULL,
  visible_epoch uuid NOT NULL,
  applied_seq bigint NOT NULL DEFAULT 0 CHECK (applied_seq >= 0),
  head_seq bigint NOT NULL DEFAULT 0 CHECK (head_seq >= applied_seq),
  visible_applied_seq bigint NOT NULL DEFAULT 0 CHECK (visible_applied_seq >= 0),
  subscription_id uuid NOT NULL,
  PRIMARY KEY(owner_user_id,origin_node_id,thread_id),
  FOREIGN KEY(owner_user_id,origin_node_id) REFERENCES computer_mirror_state(owner_user_id,origin_node_id) ON DELETE CASCADE
);
CREATE TABLE thread_range_entities (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  thread_id uuid NOT NULL,
  epoch uuid NOT NULL,
  entity_key text NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  turn_id text NOT NULL DEFAULT '',
  ordinal bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT '',
  payload bytea NOT NULL,
  PRIMARY KEY(owner_user_id,origin_node_id,thread_id,epoch,entity_key),
  FOREIGN KEY(owner_user_id,origin_node_id,thread_id)
    REFERENCES thread_range_state(owner_user_id,origin_node_id,thread_id) ON DELETE CASCADE
);
CREATE INDEX thread_range_history ON thread_range_entities(owner_user_id,origin_node_id,thread_id,epoch,kind,ordinal);
CREATE INDEX thread_range_turn_items ON thread_range_entities(owner_user_id,origin_node_id,thread_id,epoch,turn_id,ordinal);
CREATE TABLE thread_range_failures (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  thread_id uuid NOT NULL,
  reason text NOT NULL,
  code integer NOT NULL,
  retryable boolean NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,origin_node_id,thread_id),
  FOREIGN KEY(owner_user_id,origin_node_id) REFERENCES computer_mirror_state(owner_user_id,origin_node_id) ON DELETE CASCADE
);

-- Keep oversized tool output on the database side of the driver boundary.
-- The original Item is immutable and owner-scoped through its thread; only a
-- compact JSON preview is decoded by the stream producer.
CREATE FUNCTION thread_replication_json_preview(value jsonb, depth integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb; entry record;
BEGIN
  IF depth>12 THEN RETURN 'null'::jsonb; END IF;
  IF jsonb_typeof(value)='string' THEN RETURN to_jsonb(left(value#>>'{}',2048)); END IF;
  IF jsonb_typeof(value)='array' THEN
    SELECT coalesce(jsonb_agg(thread_replication_json_preview(v,depth+1)),'[]'::jsonb) INTO result
      FROM (SELECT v FROM jsonb_array_elements(value) AS a(v) LIMIT 16) limited;
    RETURN result;
  END IF;
  IF jsonb_typeof(value)='object' THEN
    result := '{}'::jsonb;
    FOR entry IN SELECT key,val FROM jsonb_each(value) AS e(key,val) LIMIT 64 LOOP
      result := result || jsonb_build_object(entry.key,thread_replication_json_preview(entry.val,depth+1));
    END LOOP;
    RETURN result;
  END IF;
  RETURN value;
END;
$$;
CREATE FUNCTION thread_replication_item_preview(target uuid, value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE bytes bytea; hash text;
BEGIN
  bytes := convert_to(value::text,'UTF8');
  IF octet_length(bytes)<=24576 THEN RETURN jsonb_build_object('value',value); END IF;
  hash := encode(sha256(bytes),'hex');
  INSERT INTO thread_replication_content(thread_id,sha256,data) VALUES(target,hash,bytes) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('value',thread_replication_json_preview(value),'sha256',hash,'size',octet_length(bytes));
END;
$$;

CREATE FUNCTION thread_replication_enqueue(target uuid, entity_kind text, entity text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE clock thread_replication_clock; pending boolean;
BEGIN
  SELECT * INTO clock FROM thread_replication_clock WHERE thread_id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT EXISTS(SELECT 1 FROM thread_replication_journal WHERE thread_id=target AND epoch=clock.epoch
      AND kind=entity_kind AND entity_id=entity AND payload IS NULL) INTO pending;
  UPDATE thread_replication_clock SET change_version=change_version+1,
    head_seq=head_seq+CASE WHEN pending THEN 0 ELSE 1 END WHERE thread_id=target RETURNING * INTO clock;
  IF pending THEN RETURN; END IF;
  INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id)
    VALUES(target,clock.epoch,clock.head_seq,entity_kind,entity);
END;
$$;

-- Id-only bootstrap. No timeline JSON/protobuf is built or copied here.
CREATE FUNCTION thread_replication_seed(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE clock thread_replication_clock; added bigint;
BEGIN
  SELECT * INTO clock FROM thread_replication_clock WHERE thread_id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Bootstrap under the source-commit barrier, allocating contiguous ids once.
  -- Calling enqueue per entity repeatedly rewrites the same clock/index pages.
  WITH candidates(kind,id) AS (
    SELECT 'thread',target::text
    UNION ALL
    SELECT 'turn' AS kind,u.id::text AS id FROM thread_fork_chain(target) c JOIN turns u ON u.thread_id=c.thread_id
      WHERE (c.level=0 OR u.status<>'queued') AND (c.upto_seq IS NULL OR u.last_seq<=c.upto_seq)
    UNION ALL
    SELECT 'item',i.item_id FROM thread_fork_chain(target) c JOIN thread_items i ON i.thread_id=c.thread_id
      WHERE c.upto_seq IS NULL OR i.first_seq<=c.upto_seq
    UNION ALL SELECT 'notice',seq::text FROM thread_events WHERE thread_id=target AND kind='notice'
    UNION ALL SELECT 'interaction',id::text FROM interaction_requests WHERE thread_id=target AND status='pending'
    UNION ALL SELECT 'steer',id::text FROM turn_steers WHERE thread_id=target
    UNION ALL SELECT 'goal',target::text WHERE EXISTS(SELECT 1 FROM goals WHERE thread_id=target)
    UNION ALL SELECT 'delivery',id::text FROM agent_bus_calls WHERE source_thread_id=target
    UNION ALL SELECT kind,entity_id FROM thread_replication_seed_entities WHERE thread_id=target
  ), missing AS (
    SELECT DISTINCT kind,id FROM candidates c WHERE NOT EXISTS (
      SELECT 1 FROM thread_replication_journal j WHERE j.thread_id=target AND j.epoch=clock.epoch
        AND j.kind=c.kind AND j.entity_id=c.id AND j.payload IS NULL
    )
  )
  INSERT INTO thread_replication_journal(thread_id,epoch,seq,kind,entity_id)
    SELECT target,clock.epoch,clock.head_seq+row_number() OVER (ORDER BY kind<>'thread',kind,id),kind,id FROM missing;
  GET DIAGNOSTICS added = ROW_COUNT;
  UPDATE thread_replication_clock SET head_seq=head_seq+added,change_version=change_version+added WHERE thread_id=target;
END;
$$;

CREATE FUNCTION thread_replication_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; entity_kind text;
BEGIN
  entity_kind := CASE NEW.entity_kind
    WHEN 'thread_items' THEN 'item' WHEN 'turns' THEN 'turn' WHEN 'thread_events' THEN 'notice'
    WHEN 'interaction_requests' THEN 'interaction' WHEN 'goals' THEN 'goal'
    WHEN 'turn_steers' THEN 'steer' WHEN 'agent_bus_calls' THEN 'delivery' ELSE 'thread' END;
  FOR target IN
    WITH RECURSIVE affected(id) AS (
      SELECT t.id FROM threads t WHERE t.owner_user_id=NEW.owner_user_id AND
        (t.id=NEW.thread_id OR (NEW.thread_id IS NULL AND
          ((NEW.entity_kind='workers' AND t.worker_id::text=NEW.entity_id)
          OR (NEW.entity_kind='projects' AND t.project_id::text=NEW.entity_id)
          OR (NEW.entity_kind='project_workspaces' AND t.workspace_id::text=NEW.entity_id))))
      UNION SELECT t.id FROM threads t JOIN affected a ON t.fork_source_thread_id=a.id
        WHERE t.owner_user_id=NEW.owner_user_id
    ) SELECT id FROM affected ORDER BY id
  LOOP
    -- Also serialize lazy bootstrap with a source transaction that started before it.
    PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_ranges:' || target.id::text,0));
    IF NOT EXISTS(SELECT 1 FROM thread_replication_clock WHERE thread_id=target.id) THEN CONTINUE; END IF;
    IF NEW.entity_kind='history_reset' THEN
      UPDATE thread_replication_clock SET epoch=gen_random_uuid(),head_seq=0,legacy_ready=false WHERE thread_id=target.id;
      PERFORM thread_replication_seed(target.id);
    ELSE
      PERFORM thread_replication_enqueue(target.id,entity_kind,
        CASE WHEN entity_kind IN ('thread','goal') THEN target.id::text ELSE NEW.entity_id END);
      IF entity_kind<>'thread' THEN PERFORM thread_replication_enqueue(target.id,'thread',target.id::text); END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER thread_replication_change AFTER INSERT ON computer_thread_changes
  FOR EACH ROW EXECUTE FUNCTION thread_replication_changed();

-- Derived public fields must advance the same journal as their backing rows.
-- These indexes keep dependency invalidation proportional to the changed source,
-- rather than scanning all sourced turns on every transcript token.
CREATE INDEX turns_replication_call ON turns(agent_call_id) WHERE agent_call_id IS NOT NULL;
CREATE INDEX turns_replication_schedule ON turns(schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX turns_replication_bot_call ON turns(bot_call_id) WHERE bot_call_id IS NOT NULL;
CREATE INDEX calls_replication_source ON agent_bus_calls(source_thread_id,source_turn_id);
CREATE INDEX calls_replication_target_turn ON agent_bus_calls(target_turn_id);
CREATE INDEX calls_replication_notified_turn ON agent_bus_calls(notified_turn_id);
CREATE INDEX interactions_replication_question ON interaction_requests(question_call_id) WHERE question_call_id IS NOT NULL;

CREATE FUNCTION thread_replication_touch(target uuid, kind text, entity text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected uuid;
BEGIN
  -- Match computer_thread_changed before acquiring any per-thread barrier.
  -- Another deferred trigger in this transaction may publish its journal later.
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0));
  FOR affected IN WITH RECURSIVE descendants(id) AS (
    SELECT target UNION SELECT t.id FROM threads t JOIN descendants d ON t.fork_source_thread_id=d.id
  ) SELECT id FROM descendants ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_ranges:' || affected::text,0));
    PERFORM thread_replication_enqueue(affected,kind,entity);
  END LOOP;
END;
$$;
CREATE FUNCTION thread_replication_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; target record; source uuid;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  source := coalesce(data->>'id',data->>'workspace_id',data->>'thread_id')::uuid;
  IF TG_TABLE_NAME='threads' THEN
    -- Token updates of last_seq do not change another turn's sender label.
    IF TG_OP='UPDATE' AND (OLD.title,OLD.provider,OLD.provider_profile_id,OLD.settings,OLD.project_id,OLD.worker_id)
      IS NOT DISTINCT FROM (NEW.title,NEW.provider,NEW.provider_profile_id,NEW.settings,NEW.project_id,NEW.worker_id) THEN RETURN NULL; END IF;
    FOR target IN SELECT u.thread_id,u.id FROM agent_bus_calls c JOIN turns u ON u.agent_call_id=c.id
        WHERE c.source_thread_id=source
      UNION SELECT u.thread_id,u.id FROM interaction_requests q JOIN turns u ON u.interaction_request_id=q.id WHERE q.thread_id=source
      UNION SELECT u.thread_id,u.id FROM interaction_requests q JOIN turns u ON u.agent_call_id=q.question_call_id WHERE q.answered_by_thread_id=source
    LOOP PERFORM thread_replication_touch(target.thread_id,'turn',target.id::text); END LOOP;
  ELSIF TG_TABLE_NAME='turns' THEN
    IF TG_OP='UPDATE' AND (OLD.status,OLD.model) IS NOT DISTINCT FROM (NEW.status,NEW.model) THEN RETURN NULL; END IF;
    FOR target IN SELECT c.source_thread_id,c.id FROM agent_bus_calls c WHERE c.target_turn_id=source LOOP
      PERFORM thread_replication_touch(target.source_thread_id,'delivery',target.id::text);
    END LOOP;
    FOR target IN SELECT u.thread_id,u.id FROM agent_bus_calls c JOIN turns u ON u.agent_call_id=c.id
      WHERE c.source_turn_id=source OR c.target_turn_id=source LOOP
      PERFORM thread_replication_touch(target.thread_id,'turn',target.id::text);
    END LOOP;
  ELSIF TG_TABLE_NAME IN ('agent_bus_calls','interaction_requests','schedules','bot_tool_calls') THEN
    FOR target IN SELECT u.thread_id,u.id FROM turns u WHERE
      (TG_TABLE_NAME='agent_bus_calls' AND u.agent_call_id=source) OR
      (TG_TABLE_NAME='interaction_requests' AND (u.interaction_request_id=source OR u.agent_call_id=(data->>'question_call_id')::uuid)) OR
      (TG_TABLE_NAME='schedules' AND u.schedule_id=source) OR
      (TG_TABLE_NAME='bot_tool_calls' AND u.bot_call_id=source)
    LOOP PERFORM thread_replication_touch(target.thread_id,'turn',target.id::text); END LOOP;
  ELSIF TG_TABLE_NAME='background_task_notes' THEN
    FOR target IN SELECT thread_id,id FROM turns WHERE id=(data->>'turn_id')::uuid LOOP
      PERFORM thread_replication_touch(target.thread_id,'turn',target.id::text);
    END LOOP;
  ELSIF TG_TABLE_NAME IN ('worktrees','checkout_heads','thread_imports') THEN
    FOR target IN SELECT id FROM threads WHERE
      (TG_TABLE_NAME='worktrees' AND worktree_id=source) OR
      (TG_TABLE_NAME='checkout_heads' AND workspace_id=source AND worktree_id IS NULL) OR
      (TG_TABLE_NAME='thread_imports' AND id=(data->>'thread_id')::uuid)
    LOOP PERFORM thread_replication_touch(target.id,'thread',target.id::text); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER thread_range_thread_dependencies AFTER INSERT OR UPDATE OR DELETE ON threads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_turn_dependencies AFTER INSERT OR UPDATE OR DELETE ON turns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_call_dependencies AFTER INSERT OR UPDATE OR DELETE ON agent_bus_calls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_question_dependencies AFTER INSERT OR UPDATE OR DELETE ON interaction_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_schedule_dependencies AFTER INSERT OR UPDATE OR DELETE ON schedules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_bot_dependencies AFTER INSERT OR UPDATE OR DELETE ON bot_tool_calls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_background_dependencies AFTER INSERT OR UPDATE OR DELETE ON background_task_notes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_worktree_dependencies AFTER INSERT OR UPDATE OR DELETE ON worktrees
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_checkout_dependencies AFTER INSERT OR UPDATE OR DELETE ON checkout_heads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
CREATE CONSTRAINT TRIGGER thread_range_import_dependencies AFTER INSERT OR UPDATE OR DELETE ON thread_imports
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thread_replication_dependencies();
