-- A report is distinct from the message whose result it reports. In particular it must never
-- change that call's target_turn_id when it enters the caller's running turn.
ALTER TABLE turn_steers ADD COLUMN notification_call_id uuid UNIQUE REFERENCES agent_bus_calls(id);
ALTER TABLE turn_steers DROP CONSTRAINT turn_steers_author;
ALTER TABLE turn_steers ADD CONSTRAINT turn_steers_author CHECK (
  CASE WHEN background_note THEN author_user_id IS NULL AND agent_call_id IS NULL AND notification_call_id IS NULL
       WHEN notification_call_id IS NOT NULL THEN author_user_id IS NULL AND agent_call_id IS NULL
       ELSE (author_user_id IS NULL) <> (agent_call_id IS NULL) END
);

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_notify_status_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_notify_status_check
  CHECK (notify_status IN ('pending', 'steering', 'delivered', 'cancelled', 'consumed_by_wait', 'consumed_by_read', 'superseded'));
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_notify;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_notify CHECK (
  notify = (notify_status IS NOT NULL)
  AND (NOT notify OR tool IN ('spawn_thread', 'send_message'))
  AND (notified_turn_id IS NULL OR notify_status IN ('delivered', 'consumed_by_wait', 'consumed_by_read', 'superseded'))
);
