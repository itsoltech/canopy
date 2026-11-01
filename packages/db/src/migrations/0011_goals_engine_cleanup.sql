-- Goals are the harness's own (docs/goals.md, decision 2026-11-01). The platform goal engine (gateway
-- continuation turns, approval of agent-proposed goals, platform budgets, goal tools on the agent bus) was
-- never built and is abandoned: its columns and states go. Nothing ever wrote them (the gateway inserts
-- goals only as created_by user or provider, and the bus never offered the goal tools).

-- Agent proposals and their approval.
ALTER TABLE goals DROP CONSTRAINT goals_approval_time;
ALTER TABLE goals DROP COLUMN approved_by;
ALTER TABLE goals DROP COLUMN approved_at;

ALTER TABLE goals DROP CONSTRAINT goals_creator;
ALTER TABLE goals DROP COLUMN created_by_call_id;
ALTER TABLE goals DROP CONSTRAINT goals_created_by_check;
-- user: set from the UI; provider: the model or the harness set it by itself.
ALTER TABLE goals ADD CONSTRAINT goals_creator CHECK (
  (created_by = 'user' AND created_by_user_id IS NOT NULL)
  OR (created_by = 'provider' AND created_by_user_id IS NULL)
);

ALTER TABLE goals DROP CONSTRAINT goals_status_check;
ALTER TABLE goals ADD CONSTRAINT goals_status_check CHECK (
  status IN ('active', 'paused', 'blocked', 'budget_limited', 'usage_limited', 'achieved', 'cancelled')
);

-- Engine choice, the evaluator's condition and the platform's budgets and usage. The harness's own budget
-- and usage stay (token_budget, tokens_used, time_used_seconds, turns_used = continuation turns or
-- evaluator checks).
ALTER TABLE goals DROP COLUMN engine;
ALTER TABLE goals DROP COLUMN scope;
ALTER TABLE goals DROP COLUMN condition;
ALTER TABLE goals DROP COLUMN cost_budget_usd;
ALTER TABLE goals DROP COLUMN time_budget_seconds;
ALTER TABLE goals DROP COLUMN turn_budget;
ALTER TABLE goals DROP COLUMN cost_used_usd;

-- The agent bus has no goal tools. Calls refused before this migration stay as they were (audit), so the
-- narrower list applies to new rows only.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (
  tool IN ('list_agents', 'spawn_thread', 'send_message', 'wait_threads',
           'get_thread', 'read_thread', 'list_threads', 'interrupt_thread', 'close_thread',
           'list_interactions', 'answer_interaction',
           'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule')
) NOT VALID;
