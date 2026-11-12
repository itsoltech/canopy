-- Dziedziczone ustawienie bota korzysta teraz z domyślnych wątków właściciela.
-- Zachowujemy jawne wybory trybu, w tym Ask first zapisany przez wcześniejszą migrację.
UPDATE bots SET configuration = jsonb_set(configuration, '{threadPermission}', '"user_default"'),
  revision = revision + 1, updated_at = now()
WHERE coalesce(configuration ->> 'threadPermission', '') IN ('', 'same_bot');
