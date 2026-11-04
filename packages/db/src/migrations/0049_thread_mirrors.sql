ALTER TABLE computer_peers ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]';

-- Deferred triggers acquire the journal lock only after business writes have taken
-- their locks. Taking it from an immediate row trigger can deadlock a concurrent
-- turn/thread transaction. A shared commit lock also orders multi-owner metadata.
-- The row counter serializes commits, unlike a sequence (which can commit out of order).
CREATE TABLE computer_thread_clock (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE computer_thread_changes (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  revision bigint NOT NULL,
  thread_id uuid,
  PRIMARY KEY (owner_user_id, revision)
);
CREATE FUNCTION computer_thread_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; thread uuid; owner uuid; rev bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0));
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='threads' THEN
    thread := (row_data->>'id')::uuid;
    owner := (row_data->>'owner_user_id')::uuid;
  ELSIF TG_ARGV[0]='metadata' THEN
    -- Shared workers can affect every owner. The clock exists even before pairing.
    FOR owner IN SELECT id FROM users ORDER BY id LOOP
      INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
      UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
      INSERT INTO computer_thread_changes VALUES(owner,rev,NULL);
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
    SELECT owner_user_id INTO owner FROM threads WHERE id=thread;
  END IF;
  IF owner IS NOT NULL THEN
    INSERT INTO computer_thread_clock(owner_user_id) VALUES(owner) ON CONFLICT DO NOTHING;
    UPDATE computer_thread_clock SET revision=revision+1 WHERE owner_user_id=owner RETURNING revision INTO rev;
    INSERT INTO computer_thread_changes VALUES(owner,rev,thread);
    IF rev % 1000 = 0 THEN
      DELETE FROM computer_thread_changes WHERE owner_user_id=owner AND revision<=rev-10000;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER computer_thread_change AFTER INSERT OR UPDATE OR DELETE ON threads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_item_change AFTER INSERT OR UPDATE OR DELETE ON thread_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_turn_change AFTER INSERT OR UPDATE OR DELETE ON turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_interaction_change AFTER INSERT OR UPDATE OR DELETE ON interaction_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_goal_change AFTER INSERT OR UPDATE OR DELETE ON goals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_steer_change AFTER INSERT OR UPDATE OR DELETE ON turn_steers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_read_change AFTER INSERT OR UPDATE OR DELETE ON thread_reads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_delivery_change AFTER INSERT OR UPDATE OR DELETE ON agent_bus_calls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_notice_change AFTER INSERT OR UPDATE OR DELETE ON thread_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed();
CREATE CONSTRAINT TRIGGER computer_project_change AFTER INSERT OR UPDATE OR DELETE ON projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed('metadata');
CREATE CONSTRAINT TRIGGER computer_worker_change AFTER INSERT OR UPDATE OR DELETE ON workers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed('metadata');
CREATE CONSTRAINT TRIGGER computer_workspace_change AFTER INSERT OR UPDATE OR DELETE ON project_workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION computer_thread_changed('metadata');

CREATE TABLE computer_mirror_state (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  cursor text NOT NULL DEFAULT '',
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  overview bytea,
  PRIMARY KEY(owner_user_id,origin_node_id),
  FOREIGN KEY(owner_user_id,origin_node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE
);
-- Protobuf projections, never execution rows or secrets. A pending generation is
-- invisible until the final checkpoint atomically replaces the previous one.
CREATE TABLE computer_mirror_threads (
  owner_user_id uuid NOT NULL,
  origin_node_id text NOT NULL,
  generation uuid NOT NULL,
  thread_id uuid NOT NULL,
  snapshot bytea NOT NULL,
  PRIMARY KEY(owner_user_id,origin_node_id,generation,thread_id),
  FOREIGN KEY(owner_user_id,origin_node_id) REFERENCES computer_mirror_state(owner_user_id,origin_node_id) ON DELETE CASCADE
);
