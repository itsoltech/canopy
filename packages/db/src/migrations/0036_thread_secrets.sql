-- 0033–0035 pozostawione dla równoległych prac.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret'
)) NOT VALID;

CREATE TABLE thread_secrets (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES turns(id),
  call_id uuid NOT NULL UNIQUE,
  label text NOT NULL,
  description text NOT NULL,
  placeholder text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'declined', 'revoked', 'expired')),
  ciphertext bytea,
  key_id text,
  expires_at timestamptz,
  revision integer NOT NULL DEFAULT 0,
  applied_revision integer NOT NULL DEFAULT 0,
  file_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'saved') = (ciphertext IS NOT NULL)),
  CHECK (status <> 'saved' OR (expires_at IS NOT NULL AND key_id IS NOT NULL))
);
CREATE INDEX thread_secrets_thread ON thread_secrets(thread_id);
CREATE INDEX thread_secrets_expiry ON thread_secrets(expires_at) WHERE status = 'saved';
