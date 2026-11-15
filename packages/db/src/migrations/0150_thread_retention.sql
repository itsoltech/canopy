-- A retained identity fences replay while large history is removed in bounded transactions.
ALTER TABLE threads ADD COLUMN purged_at timestamptz;
ALTER TABLE threads ADD COLUMN purge_completed_at timestamptz;
ALTER TABLE threads ADD CONSTRAINT threads_purge_deleted CHECK (purged_at IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE threads ADD CONSTRAINT threads_purge_completed CHECK (purge_completed_at IS NULL OR purged_at IS NOT NULL);
CREATE INDEX threads_purge_pending ON threads(owner_user_id,purged_at,id)
  WHERE purged_at IS NOT NULL AND purge_completed_at IS NULL;
CREATE INDEX threads_retained_children ON threads(parent_thread_id) WHERE purged_at IS NULL;
CREATE INDEX threads_fork_source ON threads(fork_source_thread_id) WHERE fork_source_thread_id IS NOT NULL;
CREATE INDEX worker_event_quarantine_thread ON worker_event_quarantine(thread_id);
CREATE INDEX computer_moves_thread_item ON computer_moves(owner_user_id,item_id) WHERE kind='thread';

ALTER TABLE blobs ADD COLUMN retention_exempt boolean NOT NULL DEFAULT false;
CREATE INDEX thread_blobs_sha256 ON thread_blobs(sha256);
CREATE INDEX attachments_sha256 ON attachments(sha256);
CREATE INDEX attachments_thumb_sha256 ON attachments(thumb_sha256) WHERE thumb_sha256 IS NOT NULL;
CREATE FUNCTION thread_blob_retention_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.blob.'||NEW.sha256,0));
  RETURN NEW;
END;
$$;
CREATE TRIGGER blob_retention_lock BEFORE INSERT ON blobs
  FOR EACH ROW EXECUTE FUNCTION thread_blob_retention_lock();
CREATE TRIGGER thread_blob_retention_lock BEFORE INSERT ON thread_blobs
  FOR EACH ROW EXECUTE FUNCTION thread_blob_retention_lock();

-- A soft-deleted child/fork is still restorable and continues to protect its source.
CREATE FUNCTION thread_retention_ready(p_thread_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM threads c WHERE c.parent_thread_id=p_thread_id AND c.purged_at IS NULL)
    AND NOT EXISTS(WITH RECURSIVE dependents(id,purged_at) AS (
      SELECT f.id,f.purged_at FROM threads f WHERE f.fork_source_thread_id=p_thread_id
      UNION ALL SELECT f.id,f.purged_at FROM threads f JOIN dependents d ON f.fork_source_thread_id=d.id)
      SELECT 1 FROM dependents WHERE purged_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=p_thread_id AND u.status IN ('queued','running'))
    AND NOT EXISTS(SELECT 1 FROM thread_items i WHERE i.thread_id=p_thread_id
      AND i.type='background_task' AND i.status='in_progress')
    AND NOT EXISTS(SELECT 1 FROM worker_commands c WHERE c.thread_id=p_thread_id
      AND c.status IN ('pending','delivered') AND (c.expires_at>now() OR c.kind='rewindThread'))
    AND NOT EXISTS(SELECT 1 FROM import_items i WHERE i.thread_id=p_thread_id AND i.status IN ('pending','importing'))
    AND NOT EXISTS(SELECT 1 FROM connector_executions c WHERE c.thread_id=p_thread_id AND c.status='running')
    AND NOT EXISTS(SELECT 1 FROM github_mutation_receipts r WHERE r.thread_id=p_thread_id AND r.state='in_flight')
    AND NOT EXISTS(SELECT 1 FROM computer_moves m JOIN threads t ON t.id=p_thread_id
      WHERE m.owner_user_id=t.owner_user_id AND m.kind='thread' AND m.item_id=p_thread_id
        AND m.state NOT IN ('done','aborted'))
    AND NOT EXISTS(SELECT 1 FROM thread_image_publications p WHERE p.thread_id=p_thread_id
      AND p.state='reserved' AND p.expires_at>now());
$$;

CREATE FUNCTION thread_purge_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purged_at IS NOT NULL THEN
    IF NEW.deleted_at IS NULL OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
      RAISE EXCEPTION 'This thread has been permanently deleted.' USING ERRCODE='check_violation';
    END IF;
    -- Late title/command results cannot put content back into the retained identity.
    NEW.title := ''; NEW.title_context := ''; NEW.settings := '{}'::jsonb;
    NEW.title_requested := false; NEW.status_detail := NULL;
    NEW.newest_pull_request := NULL; NEW.schedule_name := '';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER threads_purge_lifecycle BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION thread_purge_lifecycle_guard();

-- Ordinary content updates must not invert archive's thread -> content row order.
-- Writers share an advisory fence; maintenance only tries its exclusive side.
-- Maintenance bypasses only its own fenced thread, for this transaction alone.
CREATE FUNCTION thread_purge_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; purged timestamptz;
BEGIN
  IF TG_TABLE_NAME='agent_bus_calls' THEN target := NEW.source_thread_id;
  ELSIF TG_TABLE_NAME='computer_moves' THEN
    IF NEW.kind<>'thread' THEN RETURN NEW; END IF;
    SELECT id INTO target FROM threads WHERE id=NEW.item_id AND owner_user_id=NEW.owner_user_id;
  ELSIF TG_TABLE_NAME='computer_agent_calls' THEN
    IF NEW.actor_kind<>'thread' THEN RETURN NEW; END IF;
    SELECT id INTO target FROM threads WHERE id=NEW.actor_id AND owner_user_id=NEW.owner_user_id;
  ELSE target := NEW.thread_id; END IF;
  IF target IS NULL OR current_setting('canopy.thread_purge',true)=target::text THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('canopy.thread_content.'||target,0));
  SELECT purged_at INTO purged FROM threads WHERE id=target;
  IF purged IS NOT NULL THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['turns','turn_steers','agent_bus_calls','interaction_requests','goals',
    'schedules','worker_commands','thread_message_receipts','thread_rewinds','connector_executions',
    'import_items','composer_drafts','background_task_notes','pr_check_notes','thread_events','thread_items',
    'thread_visuals','thread_image_publications','thread_secrets',
    'thread_replication_seed_entities','thread_replication_journal','thread_replication_content',
    'computer_moved_threads','worker_event_quarantine','attachments','thread_blobs',
    'pr_check_watches','github_mutation_receipts','computer_moves','computer_agent_calls'] LOOP
    EXECUTE format('CREATE TRIGGER thread_purge_content BEFORE INSERT OR UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION thread_purge_content_guard()',relation);
  END LOOP;
END;
$$;

-- Publish the initial deletion to linked overviews. Later payload removal must not
-- recreate replication journals or generate one invalidation for every removed item.
CREATE OR REPLACE FUNCTION computer_thread_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; thread uuid; owner uuid; rev bigint; kind text; entity text;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='threads' THEN
    IF TG_OP='UPDATE' AND OLD.purged_at IS NOT NULL THEN RETURN NULL; END IF;
  ELSIF TG_ARGV[0] IS DISTINCT FROM 'metadata' THEN
    thread := CASE WHEN TG_TABLE_NAME='agent_bus_calls' THEN (row_data->>'source_thread_id')::uuid
      ELSE (row_data->>'thread_id')::uuid END;
    IF EXISTS(SELECT 1 FROM threads WHERE id=thread AND purged_at IS NOT NULL) THEN RETURN NULL; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('canopy.thread_mirror_journal',0));
  kind := TG_TABLE_NAME;
  entity := CASE TG_TABLE_NAME WHEN 'thread_events' THEN row_data->>'seq'
    WHEN 'thread_items' THEN row_data->>'item_id' ELSE row_data->>'id' END;
  IF TG_TABLE_NAME='worker_commands' THEN
    IF row_data->>'turn_id' IS NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND (OLD.status,OLD.result) IS NOT DISTINCT FROM (NEW.status,NEW.result) THEN RETURN NULL; END IF;
    kind := 'turns'; entity := row_data->>'turn_id';
  END IF;
  IF TG_TABLE_NAME='threads' THEN
    thread := (row_data->>'id')::uuid; owner := (row_data->>'owner_user_id')::uuid;
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
