-- Explicit child messages have the same durable observation boundary as completion reports.
ALTER TABLE agent_bus_calls ADD COLUMN message_consumed text
  CHECK (message_consumed IN ('consumed_by_wait', 'consumed_by_read', 'deduplicated'));
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_message_consumed
  CHECK (message_consumed IS NULL OR tool = 'send_message');
CREATE INDEX agent_bus_calls_messages ON agent_bus_calls (target_thread_id, source_thread_id)
  WHERE tool = 'send_message' AND message_consumed IS NULL;
