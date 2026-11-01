-- Goals are the harness's own (docs/goals.md, decision 2026-11-01): Codex thread/goal and Claude /goal drive
-- them, the platform records what the harness reports. Goals the model or the harness set by itself are
-- tracked as they are, so the approval and agent-budget gates of the platform engine no longer apply.
ALTER TABLE goals DROP CONSTRAINT goals_approval;
ALTER TABLE goals DROP CONSTRAINT goals_agent_budget;

-- Last status the harness reported (Codex: active, paused, complete, ...; Claude: active, met, failed, cleared).
ALTER TABLE goals ADD COLUMN native_status text;

-- Turns of a goal (Claude /goal turns, Codex continuation turns), for usage per goal.
CREATE INDEX turns_goal_id ON turns (goal_id) WHERE goal_id IS NOT NULL;

-- Background work (docs/execution.md) lives in thread_items (type background_task); running ones are
-- counted per thread for the UI.
CREATE INDEX thread_items_background_running ON thread_items (thread_id) WHERE type = 'background_task' AND status = 'in_progress';
