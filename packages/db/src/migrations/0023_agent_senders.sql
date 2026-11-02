-- Subagents of any provider and messages between any threads of a user (docs/agent-bus.md): a turn started by
-- another thread's agent (task, message, report) shows who sent it. The sender may live in another tree, project
-- or worker, so its title, provider, instance, project and worker come with the turn's source; the model is the one
-- the sending turn ran with (else the sender's default). Columns are added at the end (CREATE OR REPLACE VIEW).
CREATE OR REPLACE VIEW turn_sources AS
SELECT u.id AS turn_id,
       CASE
         WHEN tc.id IS NOT NULL THEN CASE tc.tool WHEN 'spawn_thread' THEN 'task' ELSE 'message' END
         WHEN nc.id IS NOT NULL THEN 'report'
         WHEN u.interaction_request_id IS NOT NULL THEN 'question'
         WHEN u.schedule_id IS NOT NULL THEN 'schedule'
       END AS source_kind,
       coalesce(tc.source_thread_id, nc.target_thread_id, ir.thread_id, sc.source_thread_id) AS source_thread_id,
       rt.status AS source_status,
       ir.kind AS question_kind,
       ir.tool_name AS question_tool,
       st.title AS source_title,
       st.provider AS source_provider,
       st.provider_profile_id AS source_profile_id,
       coalesce(nullif(su.model, ''), st.settings ->> 'model', '') AS source_model,
       st.project_id AS source_project_id,
       st.worker_id AS source_worker_id
  FROM turns u
  LEFT JOIN agent_bus_calls tc ON tc.id = u.agent_call_id AND tc.target_turn_id = u.id
  LEFT JOIN agent_bus_calls nc ON nc.id = u.agent_call_id AND nc.notified_turn_id = u.id
  LEFT JOIN turns rt ON rt.id = nc.target_turn_id
  LEFT JOIN interaction_requests ir ON ir.id = u.interaction_request_id
  LEFT JOIN schedules s ON s.id = u.schedule_id
  LEFT JOIN agent_bus_calls sc ON sc.id = s.created_by_call_id
  LEFT JOIN threads st ON st.id = coalesce(tc.source_thread_id, nc.target_thread_id, ir.thread_id, sc.source_thread_id)
  LEFT JOIN turns su ON su.id = tc.source_turn_id;

-- The sender's timeline follows the turns its calls reached (BusDelivery): calls by the turn they started.
CREATE INDEX agent_bus_calls_delivered_turn ON agent_bus_calls (target_turn_id) WHERE target_turn_id IS NOT NULL;
