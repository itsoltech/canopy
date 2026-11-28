-- Pending migrations share a transaction. Earlier backfills can leave deferred checks queued on rows whose
-- tables this migration alters.
SET CONSTRAINTS ALL IMMEDIATE;

-- More sources for bot event triggers (docs/bots.md): CI notes of watched pull requests, schedule runs,
-- provider usage limits and habit suggestions. Each writes an event only when an enabled trigger lists one of its
-- resources (bot_trigger_record).

-- A CI note of an explicit or automatic watch of a pull request linked to a thread.
CREATE FUNCTION bot_trigger_pr_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t threads%ROWTYPE;
BEGIN
  SELECT * INTO t FROM threads WHERE id = NEW.thread_id;

  IF t.id IS NULL OR t.deleted_at IS NOT NULL OR t.moved_to IS NOT NULL OR t.memory_audience LIKE 'conversation:%' THEN
    RETURN NULL;
  END IF;

  PERFORM bot_trigger_record(t.owner_user_id, 'pr.checks', NEW.id::text,
    jsonb_build_object(
      'scope', jsonb_build_object('project', t.project_id, 'repository', NEW.body ->> 'repository',
        'pull_request', NEW.body ->> 'pull_request_id'),
      'fields', jsonb_build_object('event', NEW.body ->> 'event', 'reason', nullif(NEW.body ->> 'reason', ''),
        'failed_count', coalesce((NEW.body #>> '{counts,failed}')::int, 0),
        'automatic', coalesce((NEW.body ->> 'automatic')::boolean, false))),
    jsonb_build_object('thread_id', t.id, 'pull_request_id', NEW.body ->> 'pull_request_id', 'note_id', NEW.id,
      'number', NEW.body ->> 'number'),
    NEW.hops, true);
  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_pr_checks AFTER INSERT ON pr_check_notes FOR EACH ROW
  EXECUTE FUNCTION bot_trigger_pr_checks();

-- A skipped or expired schedule occurrence, and the end of the turn a started occurrence ran. A schedule of a thread
-- delegated from an external conversation never emits.
CREATE FUNCTION bot_trigger_schedule_event(p_schedule uuid, p_scheduled_for timestamptz, p_phase text, p_status text,
  p_turn uuid, p_hops integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s schedules%ROWTYPE;
  owner uuid;
  thread uuid;
BEGIN
  SELECT * INTO s FROM schedules WHERE id = p_schedule;
  SELECT p.owner_user_id INTO owner FROM projects p WHERE p.id = s.project_id;
  thread := coalesce((SELECT u.thread_id FROM turns u WHERE u.id = p_turn), s.thread_id);

  IF s.id IS NULL OR s.memory_audience LIKE 'conversation:%' OR EXISTS (
    SELECT 1 FROM threads t WHERE t.id = thread AND (t.memory_audience LIKE 'conversation:%' OR t.deleted_at IS NOT NULL
      OR t.moved_to IS NOT NULL)) THEN
    RETURN;
  END IF;

  PERFORM bot_trigger_record(owner, 'schedule.run', p_schedule::text || ':' || p_scheduled_for::text || ':' || p_phase,
    jsonb_build_object(
      'scope', jsonb_build_object('schedule', p_schedule, 'project', s.project_id),
      'fields', jsonb_build_object('phase', p_phase, 'status', p_status)),
    jsonb_strip_nulls(jsonb_build_object('schedule_id', p_schedule, 'scheduled_for', p_scheduled_for,
      'thread_id', thread, 'turn_id', p_turn)),
    p_hops, true);
END
$$;

CREATE FUNCTION bot_trigger_schedule_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bot_trigger_schedule_event(NEW.schedule_id, NEW.scheduled_for,
    CASE WHEN NEW.outcome = 'expired' THEN 'expired' ELSE 'skipped' END, NULL, NULL, 0);
  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_schedule_run_insert AFTER INSERT ON schedule_runs FOR EACH ROW
  WHEN (NEW.outcome IN ('missed', 'running', 'expired'))
  EXECUTE FUNCTION bot_trigger_schedule_run();

CREATE TRIGGER bot_trigger_schedule_run_update AFTER UPDATE OF outcome ON schedule_runs FOR EACH ROW
  WHEN (OLD.outcome IS DISTINCT FROM NEW.outcome AND NEW.outcome IN ('missed', 'running', 'expired'))
  EXECUTE FUNCTION bot_trigger_schedule_run();

-- The run a scheduled turn started, found without a scan.
CREATE INDEX schedule_runs_turn ON schedule_runs (turn_id) WHERE turn_id IS NOT NULL;

CREATE FUNCTION bot_trigger_schedule_finished() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run schedule_runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM schedule_runs WHERE turn_id = NEW.id LIMIT 1;

  IF run.schedule_id IS NOT NULL THEN
    PERFORM bot_trigger_schedule_event(run.schedule_id, run.scheduled_for, 'finished', NEW.status, NEW.id, NEW.hops);
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_schedule_finished AFTER UPDATE OF status ON turns FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.schedule_id IS NOT NULL
    AND NEW.status IN ('completed', 'failed', 'interrupted'))
  EXECUTE FUNCTION bot_trigger_schedule_finished();

-- A usage window that rose since the previous observation of the same account, configuration and reset. Each
-- owner who may see the profile's usage on this worker (as the usage view checks) gets the event. The matcher
-- reports a trigger only when the rise crosses its threshold from a baseline observed after the trigger's
-- revision, once per window and reset.
CREATE FUNCTION bot_trigger_provider_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w workers%ROWTYPE;
  v_harness text := CASE NEW.provider WHEN 1 THEN 'claude' WHEN 2 THEN 'codex' WHEN 3 THEN 'grok' END;
  v_profile text;
  owner uuid;
  win jsonb;
  previous double precision;
  used double precision;
BEGIN
  IF OLD.account_key IS DISTINCT FROM NEW.account_key OR OLD.config_version IS DISTINCT FROM NEW.config_version
    OR v_harness IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO w FROM workers WHERE id = NEW.worker_id;

  IF w.id IS NULL OR w.archived_at IS NOT NULL OR w.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  v_profile := v_harness || '/' || NEW.profile_id;

  FOR win IN SELECT value FROM jsonb_array_elements(coalesce(NEW.snapshot -> 'windows', '[]'::jsonb)) LOOP
    used := (win ->> 'usedPercent')::double precision;

    SELECT (o ->> 'usedPercent')::double precision INTO previous
    FROM jsonb_array_elements(coalesce(OLD.snapshot -> 'windows', '[]'::jsonb)) o
    WHERE o ->> 'key' = win ->> 'key' AND (o ->> 'resetsAt') IS NOT DISTINCT FROM (win ->> 'resetsAt')
      AND (o ->> 'windowMinutes') IS NOT DISTINCT FROM (win ->> 'windowMinutes') LIMIT 1;

    CONTINUE WHEN used IS NULL OR previous IS NULL OR used <= previous;

    FOR owner IN SELECT DISTINCT s.owner_user_id FROM bot_trigger_scopes s
      JOIN provider_instances i ON i.harness = v_harness AND i.id = NEW.profile_id
      LEFT JOIN provider_instance_workers a ON a.worker_id = NEW.worker_id AND a.harness = i.harness
        AND a.instance_id = i.id
      WHERE s.event = 'provider.limit' AND s.kind = 'profile' AND s.ref_id = v_profile
        AND (w.owner_user_id IS NULL OR w.owner_user_id = s.owner_user_id)
        AND (i.created_by IS NULL OR i.created_by = s.owner_user_id)
        AND i.kind = 'native' AND i.proxy_id IS NULL AND a.proxy_id IS NULL AND coalesce(a.enabled, i.all_workers) LOOP
      PERFORM bot_trigger_record(owner, 'provider.limit',
        NEW.worker_id::text || ':' || v_profile || ':' || (win ->> 'key') || ':' || coalesce(win ->> 'windowMinutes', '')
          || ':' || coalesce(win ->> 'resetsAt', '') || ':' || NEW.observed_at::text,
        jsonb_build_object(
          'scope', jsonb_build_object('worker', NEW.worker_id, 'profile', v_profile),
          'fields', jsonb_build_object('window', win ->> 'key', 'used_percent', used),
          'previous', jsonb_build_object('used_percent', previous, 'observed_at', extract(epoch FROM OLD.observed_at))),
        jsonb_strip_nulls(jsonb_build_object('resets_at', win ->> 'resetsAt',
          'config_version', NEW.config_version::text,
          'once', NEW.worker_id::text || ':' || v_profile || ':' || (win ->> 'key') || ':'
            || coalesce(win ->> 'windowMinutes', '') || ':' || coalesce(win ->> 'resetsAt', ''))),
        0, false);
    END LOOP;
  END LOOP;

  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_provider_limit AFTER UPDATE OF snapshot ON provider_usage FOR EACH ROW
  EXECUTE FUNCTION bot_trigger_provider_limit();

-- A habit suggestion that is ready for the owner's review.
CREATE FUNCTION bot_trigger_habit_suggested() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bot_trigger_record(NEW.owner_user_id, 'habit.suggested', NEW.id::text || ':' || NEW.revision::text,
    jsonb_build_object('scope', jsonb_build_object('project', NEW.project_id), 'fields', '{}'::jsonb),
    jsonb_build_object('habit_id', NEW.id), 0, false);
  RETURN NULL;
END
$$;

CREATE TRIGGER bot_trigger_habit_insert AFTER INSERT ON memory_habits FOR EACH ROW
  WHEN (NEW.state = 'pending')
  EXECUTE FUNCTION bot_trigger_habit_suggested();

CREATE TRIGGER bot_trigger_habit_update AFTER UPDATE OF state, revision ON memory_habits FOR EACH ROW
  WHEN (NEW.state = 'pending' AND (OLD.state IS DISTINCT FROM NEW.state OR OLD.revision IS DISTINCT FROM NEW.revision))
  EXECUTE FUNCTION bot_trigger_habit_suggested();
