ALTER TABLE turns ADD COLUMN service_tier text NOT NULL DEFAULT '';
ALTER TABLE turn_steers ADD COLUMN service_tier text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION canopy_thread_list_settings(value jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('model',value->'model','effort',value->'effort',
    'serviceTier',value->'serviceTier',
    'permissionMode',value->'permissionMode','permissionModeNote',value->'permissionModeNote'))
$$;

UPDATE threads SET settings = settings WHERE settings ? 'serviceTier';
