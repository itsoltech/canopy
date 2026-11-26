ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'start_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'show_video', 'import_image_reply', 'render_visual', 'render_html',
  'watch_pr_checks', 'list_pr_watches', 'cancel_pr_watch', 'link_pull_request', 'message_delegating_bot',
  'find_canopy_settings', 'list_project_secrets', 'switch_worktree'
)) NOT VALID;

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_starts_turn;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_starts_turn CHECK (
  (CASE WHEN tool='switch_worktree' AND status='completed' AND arguments='{}' AND result IS NULL THEN true
    ELSE ((tool IN ('spawn_thread','start_thread','send_message','ask_user') OR
        (tool='switch_worktree' AND arguments ? 'continuation')) AND status<>'failed') = (hops IS NOT NULL)
   END)
  AND (tool IN ('spawn_thread','start_thread','send_message','ask_user') OR target_turn_id IS NULL)
) NOT VALID;

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_notify;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_notify CHECK (
  notify = (notify_status IS NOT NULL)
  AND (NOT notify OR tool IN ('spawn_thread', 'start_thread', 'send_message'))
  AND (notify OR (notified_turn_id IS NULL AND notified_steer_id IS NULL))
  AND (notify_status <> 'delivered' OR notified_turn_id IS NOT NULL OR notified_steer_id IS NOT NULL)
  AND (notify_status <> 'steering' OR notified_steer_id IS NOT NULL)
  AND (notified_turn_id IS NULL OR notify_status IN ('delivered', 'consumed_by_wait', 'consumed_by_read', 'superseded'))
) NOT VALID;

CREATE OR REPLACE VIEW turn_sources AS
SELECT u.id AS turn_id,
       CASE
         WHEN tc.tool IN ('spawn_thread', 'start_thread') THEN 'task'
         WHEN tc.tool = 'ask_user' THEN 'answer'
         WHEN tc.id IS NOT NULL THEN 'message'
         WHEN nc.id IS NOT NULL THEN 'report'
         WHEN u.interaction_request_id IS NOT NULL THEN 'question'
         WHEN u.schedule_id IS NOT NULL THEN 'schedule'
         WHEN u.trigger = 'background_task' THEN 'background_task'
       END AS source_kind,
       CASE WHEN tc.tool = 'ask_user' THEN qa.answered_by_thread_id
            ELSE coalesce(tc.source_thread_id, nc.target_thread_id, ir.thread_id, sc.source_thread_id) END AS source_thread_id,
       rt.status AS source_status,
       ir.kind AS question_kind,
       ir.tool_name AS question_tool,
       st.title AS source_title,
       st.provider AS source_provider,
       st.provider_profile_id AS source_profile_id,
       coalesce(nullif(su.model, ''), st.settings ->> 'model', '') AS source_model,
       st.project_id AS source_project_id,
       st.worker_id AS source_worker_id,
       CASE WHEN u.trigger = 'background_task'
            THEN ARRAY(SELECT n.item_id FROM background_task_notes n WHERE n.turn_id = u.id ORDER BY n.ended_at, n.item_id)
       END AS background_item_ids,
       qa.answered_by_bot_id AS answer_bot_id
  FROM turns u
  LEFT JOIN agent_bus_calls tc ON tc.id = u.agent_call_id AND tc.target_turn_id = u.id
  LEFT JOIN interaction_requests qa ON tc.tool = 'ask_user' AND qa.question_call_id = tc.id
  LEFT JOIN agent_bus_calls nc ON nc.id = u.agent_call_id AND nc.notified_turn_id = u.id
  LEFT JOIN turns rt ON rt.id = nc.target_turn_id
  LEFT JOIN interaction_requests ir ON ir.id = u.interaction_request_id
  LEFT JOIN schedules s ON s.id = u.schedule_id
  LEFT JOIN agent_bus_calls sc ON sc.id = s.created_by_call_id
  LEFT JOIN threads st ON st.id = CASE WHEN tc.tool = 'ask_user' THEN qa.answered_by_thread_id
                                       ELSE coalesce(tc.source_thread_id, nc.target_thread_id, ir.thread_id, sc.source_thread_id) END
  LEFT JOIN turns su ON su.id = CASE WHEN tc.tool = 'ask_user' THEN NULL ELSE tc.source_turn_id END;
