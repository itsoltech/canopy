-- Empty identifies ordinary owner work. A delegated session keeps its audience for its entire
-- lifetime: steers, native resumes and provider continuations share the same transcript.
ALTER TABLE threads ADD COLUMN memory_audience text NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN memory_audience text NOT NULL DEFAULT '';

-- Older delegations could target any existing session. Their histories and pending reports
-- cannot be assigned to one conversation after the fact. Quarantine them and their descendants.
WITH RECURSIVE owner_inputs(id,bot_id) AS (
  SELECT t.id,t.bot_id FROM bot_turns t JOIN bot_messages m ON m.turn_id=t.id
    WHERE t.conversation_id IS NULL AND t.routine_id IS NULL AND t.handoff_configuration IS NULL
      AND t.reply_to_bot_id IS NULL AND t.exchange_id IS NULL AND t.remote_recipient_ref IS NULL AND t.hops=0
      AND m.bot_id=t.bot_id AND m.recipient_id=t.bot_id::text AND m.message_key='input'
      AND m.sender_id='user' AND m.kind='message' AND m.exchange_id IS NULL
), owner_routines(id,bot_id,hops) AS (
  SELECT r.id,r.bot_id,r.hops FROM bot_routines r JOIN bot_tool_calls c ON c.id=r.id
    JOIN owner_inputs o ON o.id=c.turn_id AND o.bot_id=r.bot_id
    WHERE c.tool->>'name'='create_routine'
), restricted_calls(id) AS (
  SELECT c.id FROM bot_tool_calls c JOIN bot_turns t ON t.id=c.turn_id
    LEFT JOIN owner_inputs o ON o.id=t.id
    LEFT JOIN owner_routines r ON r.id=t.routine_id AND r.bot_id=t.bot_id
    WHERE o.id IS NULL AND NOT COALESCE(t.conversation_id IS NULL AND t.exchange_id IS NULL
      AND t.reply_to_bot_id IS NULL AND t.remote_recipient_ref IS NULL AND t.handoff_configuration IS NULL
      AND t.hops=r.hops AND t.client_request_id LIKE ('routine:' || r.id::text || ':%'),false)
), restricted_schedules(id,thread_id) AS (
  UPDATE schedules s SET memory_audience='legacy:schedule:' || s.id::text
    FROM bot_tool_calls c JOIN restricted_calls r ON r.id=c.id
    WHERE c.tool->>'source'='platform' AND c.tool->>'name' IN ('create_schedule','update_schedule')
      AND c.status='completed' AND c.result->>'id'=s.id::text
    RETURNING s.id,s.thread_id
), roots(id) AS (
  SELECT t.id FROM threads t WHERE t.remote_parent_ref IS NOT NULL OR t.creation_request_id LIKE 'move:%'
  UNION SELECT thread_id FROM restricted_schedules WHERE thread_id IS NOT NULL
  UNION SELECT sr.thread_id FROM schedule_runs sr JOIN restricted_schedules s ON s.id=sr.schedule_id
    WHERE sr.thread_id IS NOT NULL
  UNION SELECT thread_id FROM computer_moved_threads
  UNION SELECT target_id FROM computer_agent_calls
    WHERE direction='incoming' AND target_kind='thread' AND target_id IS NOT NULL
  UNION SELECT w.target_thread_id FROM bot_thread_watches w
    JOIN restricted_calls c ON c.id=w.call_id
  UNION SELECT t.id FROM threads t JOIN restricted_calls r ON r.id::text=t.creation_request_id
    JOIN bot_tool_calls c ON c.id=r.id WHERE c.tool->>'source'='platform' AND c.tool->>'name' IN ('start_thread','fork_thread')
), edges(source,target) AS (
  SELECT parent_thread_id,id FROM threads WHERE parent_thread_id IS NOT NULL
  UNION ALL SELECT fork_source_thread_id,id FROM threads WHERE fork_source_thread_id IS NOT NULL
  UNION ALL SELECT p.id,t.id FROM threads t JOIN threads p ON p.owner_user_id=t.owner_user_id
    AND p.id::text=split_part(t.creation_request_id, ':', 2)
    WHERE t.creation_request_id LIKE 'worktree-continuation:%'
  UNION ALL SELECT source_thread_id,target_thread_id FROM agent_bus_calls WHERE target_thread_id IS NOT NULL
  UNION ALL SELECT c.source_thread_id,s.thread_id FROM schedules s
    JOIN agent_bus_calls c ON c.id=s.created_by_call_id WHERE s.thread_id IS NOT NULL
), reached(id) AS (
  SELECT id FROM roots UNION SELECT e.target FROM reached r JOIN edges e ON e.source=r.id
)
UPDATE threads t SET memory_audience=CASE WHEN t.creation_request_id LIKE 'move:%'
  THEN 'legacy:move:' || split_part(t.creation_request_id, ':', 2) ELSE 'legacy:' || t.id::text END FROM reached r WHERE r.id=t.id;
