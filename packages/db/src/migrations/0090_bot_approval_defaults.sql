-- Existing bots keep the pre-upgrade Ask first behavior, including full-auto bots.
UPDATE bots SET configuration = jsonb_set(configuration, '{threadPermission}', '"ask"')
WHERE coalesce(configuration ->> 'threadPermission', '') = '';

CREATE INDEX bot_started_threads_bot ON bot_started_threads(bot_id);
