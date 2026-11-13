-- Reserve turn budgets before worker/gateway allocation. A lease fences retries
-- after a process dies; committed rows retain per-turn accounting durably.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images'
)) NOT VALID;

CREATE TABLE thread_image_publications (
  call_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  request_hash text NOT NULL,
  lease_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'committed')),
  image_count integer NOT NULL CHECK (image_count BETWEEN 1 AND 10),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800)
);
CREATE INDEX thread_image_publications_turn ON thread_image_publications(turn_id);
CREATE INDEX thread_image_publications_worker ON thread_image_publications(worker_id, expires_at)
  WHERE state = 'reserved';
