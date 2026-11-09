-- The migrator applies pending migrations in one transaction. Flush deferred
-- checks from earlier data repairs before PostgreSQL builds indexes on turns.
SET CONSTRAINTS ALL IMMEDIATE;

-- Sidebar activity is a single indexed lookup, independent of the thread's turn count.
CREATE INDEX turns_last_activity ON turns(thread_id,
  (greatest(queued_at,coalesce(started_at,queued_at),coalesce(completed_at,queued_at))) DESC);
CREATE INDEX turns_mutable_sources ON turns(thread_id) WHERE
  agent_call_id IS NOT NULL OR interaction_request_id IS NOT NULL OR schedule_id IS NOT NULL
  OR bot_call_id IS NOT NULL OR trigger='background_task';

-- Moved history is hashed on writes, never on every WatchThread snapshot.
ALTER TABLE computer_moved_threads ADD COLUMN history_hash text
  GENERATED ALWAYS AS (md5(history)) STORED;

-- Project only UI metadata when settings/config contain large instruction strings.
CREATE FUNCTION canopy_thread_list_settings(value jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('model',value->'model','effort',value->'effort',
    'permissionMode',value->'permissionMode'))
$$;
ALTER TABLE threads ADD COLUMN list_settings jsonb
  GENERATED ALWAYS AS (canopy_thread_list_settings(settings)) STORED;

CREATE FUNCTION canopy_worker_profile_names(value jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_object_agg(p->>'id',coalesce(p->>'displayName','')), '{}'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value->'profiles')='array'
    THEN value->'profiles' ELSE '[]'::jsonb END) p
  WHERE jsonb_typeof(p->'id')='string' AND
    (p->'displayName' IS NULL OR jsonb_typeof(p->'displayName')='string')
$$;
ALTER TABLE worker_configs ADD COLUMN profile_names jsonb
  GENERATED ALWAYS AS (canopy_worker_profile_names(config)) STORED;
