-- Dziedziczone ustawienie bota korzysta teraz z domyślnych wątków właściciela.
-- Zachowujemy jawne wybory trybu, w tym Ask first zapisany przez wcześniejszą migrację.
UPDATE bots SET configuration = jsonb_set(configuration, '{threadPermission}', '"user_default"'),
  revision = revision + 1, updated_at = now()
WHERE coalesce(configuration ->> 'threadPermission', '') IN ('', 'same_bot');

-- Listy i szczegóły wątku czytają tę projekcję zamiast pełnych instrukcji agenta.
CREATE OR REPLACE FUNCTION canopy_thread_list_settings(value jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('model',value->'model','effort',value->'effort',
    'permissionMode',value->'permissionMode','permissionModeNote',value->'permissionModeNote'))
$$;
