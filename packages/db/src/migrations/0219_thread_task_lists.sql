-- The migrator holds a transaction/advisory lock. CONCURRENTLY is not valid here.
-- The thread list reads each thread's latest task list (update_tasks or a harness checklist,
-- docs/agent-bus.md "Lista zadań"). Only checklist items enter the index, so threads without one cost nothing.
CREATE INDEX thread_items_task_lists ON thread_items (thread_id, first_seq DESC)
  WHERE parent_item_id IS NULL AND (
    type = 'todo_list'
    OR type = 'plan'
    OR (type = 'agent_bus_call' AND content->'agentBusCall'->>'toolName' = 'update_tasks')
    OR (type = 'tool_call' AND content->'toolCall'->>'name' IN ('TodoWrite', 'update_plan', 'todo_write'))
  );
