-- Pending migrations share a transaction. Earlier backfills can leave deferred checks queued on rows whose
-- tables this migration alters.
SET CONSTRAINTS ALL IMMEDIATE;

-- Thread events for bot event triggers (docs/bots.md). Written with the source fact, only when an enabled trigger
-- lists the thread, its project or its worker. Threads delegated from an external conversation never emit.
CREATE FUNCTION bot_trigger_thread_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t threads%ROWTYPE;
  facts jsonb;
  context jsonb;
  occurrence text;
  hops integer := 0;
BEGIN
  SELECT * INTO t FROM threads WHERE id = NEW.thread_id;

  IF t.id IS NULL OR t.deleted_at IS NOT NULL OR t.moved_to IS NOT NULL OR t.memory_audience LIKE 'conversation:%' THEN
    RETURN NULL;
  END IF;

  IF TG_ARGV[0] = 'thread.turn_finished' THEN
    occurrence := NEW.id::text;
    hops := NEW.hops;
    facts := jsonb_build_object(
      'scope', jsonb_build_object('project', t.project_id, 'worker', t.worker_id, 'thread', t.id),
      'fields', jsonb_build_object('status', NEW.status, 'thread_origin', t.origin));
    context := jsonb_build_object('thread_id', t.id, 'turn_id', NEW.id, 'bot_call_id', NEW.bot_call_id);
  ELSE
    occurrence := NEW.id::text;
    SELECT coalesce(max(u.hops), 0) INTO hops FROM turns u WHERE u.id = NEW.turn_id;
    facts := jsonb_build_object(
      'scope', jsonb_build_object('project', t.project_id, 'worker', t.worker_id, 'thread', t.id),
      'fields', jsonb_build_object('kind', NEW.kind, 'tool_name', NEW.tool_name));
    context := jsonb_build_object('thread_id', t.id, 'turn_id', NEW.turn_id, 'request_id', NEW.id,
      'bot_call_id', (SELECT u.bot_call_id FROM turns u WHERE u.id = NEW.turn_id));
  END IF;

  PERFORM bot_trigger_record(t.owner_user_id, TG_ARGV[0], occurrence, facts, context, hops, true);
  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_turn_finished AFTER UPDATE OF status ON turns FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND (NEW.status IN ('completed', 'failed')
    OR (NEW.status = 'interrupted' AND NEW.interrupt_source IS DISTINCT FROM 'user')))
  EXECUTE FUNCTION bot_trigger_thread_event('thread.turn_finished');

CREATE TRIGGER bot_trigger_needs_input AFTER INSERT ON interaction_requests FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.routed_to = 'human')
  EXECUTE FUNCTION bot_trigger_thread_event('thread.needs_input');
