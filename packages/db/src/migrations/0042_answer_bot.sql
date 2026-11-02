-- Who answered a question when it was a bot on the user's behalf (bot answer_interaction): the timeline shows
-- "Answer from ‹bot›". answered_by stays the owner (the bot acts for them).
ALTER TABLE interaction_requests ADD COLUMN answered_by_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
-- Earlier bot answers: the completed answer_interaction call that answered the same request.
UPDATE interaction_requests q SET answered_by_bot_id = bt.bot_id
  FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id
 WHERE bc.tool ->> 'name' = 'answer_interaction' AND bc.status = 'completed' AND bc.arguments ->> 'request_id' = q.id::text
   AND q.status = 'answered' AND q.answered_by_bot_id IS NULL AND coalesce(bc.result ->> 'error', '') = '';

-- 0024's view: answers to an agent's own ask_user are their own source kind ("answer"), from whoever answered
-- (the parent thread, a bot or you), instead of a "message" from the asking thread itself. New column at the end.
CREATE OR REPLACE VIEW turn_sources AS
SELECT u.id AS turn_id,
       CASE
         WHEN tc.id IS NOT NULL THEN CASE tc.tool WHEN 'spawn_thread' THEN 'task' WHEN 'ask_user' THEN 'answer' ELSE 'message' END
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
