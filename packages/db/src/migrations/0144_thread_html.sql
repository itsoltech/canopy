-- HTML stays in the versioned visual pipeline; old clients refuse kit version 2.
ALTER TABLE thread_visuals ADD COLUMN html_document boolean NOT NULL DEFAULT false;
ALTER TABLE thread_visuals DROP CONSTRAINT thread_visuals_spec_check;
-- JSON escaping can expand a 512 KiB document sixfold. The gateway bounds input before JSON parsing.
ALTER TABLE thread_visuals ADD CONSTRAINT thread_visuals_spec_check
  CHECK (octet_length(spec) <= CASE WHEN html_document THEN 3145740 ELSE 131072 END);
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'import_image_reply', 'render_visual', 'render_html'
)) NOT VALID;
