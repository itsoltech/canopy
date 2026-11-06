-- Entity keys extend the existing commit-ordered journal; no second cursor or retention policy.
ALTER TABLE computer_thread_changes ADD COLUMN entity_kind text;
ALTER TABLE computer_thread_changes ADD COLUMN entity_id text;
-- Header preflights must not decode megabytes of timeline just to read the title.
ALTER TABLE computer_mirror_threads ADD COLUMN thread_metadata bytea;
-- Fence overlapping reconnects before either stream reaches its next checkpoint.
ALTER TABLE computer_mirror_state ADD COLUMN subscription_id uuid NOT NULL DEFAULT gen_random_uuid();

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
    kind := 'turns';
    entity := row_data->>'turn_id';
  END IF;
  IF TG_TABLE_NAME='threads' THEN
    thread := (row_data->>'id')::uuid;
    owner := (row_data->>'owner_user_id')::uuid;
    IF TG_OP<>'UPDATE' THEN
      kind := 'history_reset';
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
      IF rev % 1000 = 0 THEN
        DELETE FROM computer_thread_changes WHERE owner_user_id=owner AND revision<=rev-10000;
      END IF;
    END LOOP;
    RETURN NULL;
  ELSE
    IF TG_TABLE_NAME='agent_bus_calls' THEN
      thread := (row_data->>'source_thread_id')::uuid;
    ELSE
      thread := (row_data->>'thread_id')::uuid;
    END IF;
    IF TG_TABLE_NAME='computer_moved_threads' THEN kind := 'history_reset'; END IF;
    SELECT owner_user_id INTO owner FROM threads WHERE id=thread;
  END IF;
  IF owner IS NOT NULL THEN
    INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
    UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
    INSERT INTO computer_thread_changes(owner_user_id,revision,thread_id,entity_kind,entity_id)
      VALUES(owner,rev,thread,kind,entity);
    IF rev % 1000 = 0 THEN
      DELETE FROM computer_thread_changes WHERE owner_user_id=owner AND revision<=rev-10000;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER computer_moved_history_change AFTER INSERT OR UPDATE OR DELETE ON computer_moved_threads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_dispatch_change AFTER INSERT OR UPDATE OR DELETE ON worker_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
