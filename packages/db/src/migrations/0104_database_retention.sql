-- Maintenance progress survives restarts; business history and deduplication keys stay intact.
CREATE TABLE database_maintenance (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id),
  next_run_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE worker_commands ADD COLUMN payload_pruned_at timestamptz;
ALTER TABLE bot_harness_turns ADD COLUMN finished_at timestamptz;
ALTER TABLE bot_harness_turns ADD COLUMN events_pruned_at timestamptz;
UPDATE bot_harness_turns SET finished_at=now() WHERE outcome IS NOT NULL;
CREATE TABLE bot_harness_cursors (
  worker_id uuid NOT NULL REFERENCES workers(id),
  journal_id text NOT NULL,
  bot_id uuid NOT NULL REFERENCES bots(id),
  last_seq bigint NOT NULL,
  PRIMARY KEY(worker_id,journal_id,bot_id)
);
INSERT INTO bot_harness_cursors(worker_id,journal_id,bot_id,last_seq)
SELECT e.worker_id,e.journal_id,h.bot_id,max(e.journal_seq)
FROM bot_harness_events e JOIN bot_harness_turns h ON h.turn_id=e.turn_id
GROUP BY e.worker_id,e.journal_id,h.bot_id;

-- Register a generation before its first write. Legacy staging is protected until its subscription is fenced.
CREATE TABLE computer_mirror_generations (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  generation uuid NOT NULL,
  subscription_id uuid NOT NULL,
  lease_until timestamptz,
  PRIMARY KEY(owner_user_id,origin_node_id,generation),
  FOREIGN KEY(owner_user_id,origin_node_id) REFERENCES computer_mirror_state(owner_user_id,origin_node_id) ON DELETE CASCADE
);
INSERT INTO computer_mirror_generations(owner_user_id,origin_node_id,generation,subscription_id)
SELECT DISTINCT t.owner_user_id,t.origin_node_id,t.generation,s.subscription_id
FROM computer_mirror_threads t JOIN computer_mirror_state s USING(owner_user_id,origin_node_id);

-- Keep the commit ordering and epoch. Bounded background maintenance now owns journal pruning.
CREATE OR REPLACE FUNCTION computer_thread_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; thread uuid; owner uuid; rev bigint; kind text; entity text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0));
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  kind := TG_TABLE_NAME;
  entity := CASE TG_TABLE_NAME WHEN 'thread_events' THEN row_data->>'seq'
    WHEN 'thread_items' THEN row_data->>'item_id' ELSE row_data->>'id' END;
  IF TG_TABLE_NAME='worker_commands' THEN
    IF row_data->>'turn_id' IS NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND (OLD.status,OLD.result) IS NOT DISTINCT FROM (NEW.status,NEW.result) THEN RETURN NULL; END IF;
    kind := 'turns'; entity := row_data->>'turn_id';
  END IF;
  IF TG_TABLE_NAME='threads' THEN
    thread := (row_data->>'id')::uuid;
    owner := (row_data->>'owner_user_id')::uuid;
    IF TG_OP<>'UPDATE' THEN kind := 'history_reset';
    ELSIF (to_jsonb(OLD)->'fork_source_thread_id',to_jsonb(OLD)->'fork_upto_seq',to_jsonb(OLD)->'fork_after_turn_id')
      IS DISTINCT FROM (row_data->'fork_source_thread_id',row_data->'fork_upto_seq',row_data->'fork_after_turn_id') THEN
      kind := 'history_reset';
    END IF;
  ELSIF TG_ARGV[0]='metadata' THEN
    FOR owner IN SELECT id FROM users ORDER BY id LOOP
      INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
      UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
      INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind,entity_id)
        VALUES(owner,rev,NULL,kind,entity);
    END LOOP;
    RETURN NULL;
  ELSE
    IF TG_TABLE_NAME='agent_bus_calls' THEN thread := (row_data->>'source_thread_id')::uuid;
    ELSE thread := (row_data->>'thread_id')::uuid; END IF;
    IF TG_TABLE_NAME='computer_moved_threads' THEN kind := 'history_reset'; END IF;
    SELECT owner_user_id INTO owner FROM threads WHERE id=thread;
  END IF;
  IF owner IS NOT NULL THEN
    INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
    UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
    INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind,entity_id)
      VALUES(owner,rev,thread,kind,entity);
  END IF;
  RETURN NULL;
END;
$$;
