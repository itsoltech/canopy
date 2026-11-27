-- update_tasks (0219's task lists) is an agent bus tool: record its calls like every other tool.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'start_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'show_video', 'import_image_reply', 'render_visual', 'render_html',
  'watch_pr_checks', 'list_pr_watches', 'cancel_pr_watch', 'link_pull_request', 'message_delegating_bot',
  'find_canopy_settings', 'list_project_secrets', 'switch_worktree', 'update_tasks'
)) NOT VALID;
