-- Agent bus runtime (docs/agent-bus.md).

-- A refused spawn_thread / send_message starts no turn, so it has no hops. The others carry the hops
-- of the turn they start.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_starts_turn;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_starts_turn CHECK (
  (tool IN ('spawn_thread', 'send_message') AND status <> 'failed') = (hops IS NOT NULL)
  AND (tool IN ('spawn_thread', 'send_message') OR target_turn_id IS NULL)
);

-- "Was this question already forwarded to the parent?" and "cancel the parent's turn once answered".
CREATE INDEX turns_interaction_request ON turns (interaction_request_id) WHERE interaction_request_id IS NOT NULL;
-- close_thread cancels pending notifications about the closed thread.
CREATE INDEX agent_bus_calls_target_thread ON agent_bus_calls (target_thread_id) WHERE notify_status = 'pending';
