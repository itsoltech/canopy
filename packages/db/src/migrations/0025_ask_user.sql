-- Pytania platformy korzystają z istniejących interakcji; nie wygasają razem z procesem dostawcy.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'get_goal', 'propose_goal', 'update_goal', 'ask_user', 'get_answers'
));
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_starts_turn;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_starts_turn CHECK (
  (tool IN ('spawn_thread', 'send_message', 'ask_user') AND status <> 'failed') = (hops IS NOT NULL)
  AND (tool IN ('spawn_thread', 'send_message', 'ask_user') OR target_turn_id IS NULL)
);

ALTER TABLE interaction_requests ADD COLUMN question_call_id uuid UNIQUE REFERENCES agent_bus_calls(id);
ALTER TABLE interaction_requests ADD COLUMN question_wait boolean;
-- pending = trwały outbox odpowiedzi; consumed = odebrana przez wywołanie synchroniczne.
ALTER TABLE interaction_requests ADD COLUMN answer_delivery text CHECK (answer_delivery IN ('pending', 'consumed', 'delivered', 'cancelled'));
ALTER TABLE interaction_requests ADD COLUMN answer_steer_id uuid REFERENCES turn_steers(id);
ALTER TABLE interaction_requests ADD COLUMN answer_turn_id uuid REFERENCES turns(id);
ALTER TABLE interaction_requests ADD CONSTRAINT interaction_platform_question CHECK (
  (question_call_id IS NULL) = (question_wait IS NULL)
  AND (question_call_id IS NULL OR (kind = 'question' AND tool_name = 'ask_user'))
);
CREATE INDEX interaction_answer_outbox ON interaction_requests(id) WHERE answer_delivery = 'pending';
