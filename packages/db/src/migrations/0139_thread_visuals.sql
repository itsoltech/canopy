-- Interactive visuals (docs/agent-visuals.md): immutable, validated spec versions owned by a thread. The timeline
-- carries only the manifest item; clients read the spec with GetVisual.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'import_image_reply', 'render_visual'
)) NOT VALID;

CREATE TABLE thread_visuals (
  visual_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  -- The turn that published this version; the item keeps its place from version 1.
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE,
  item_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  height integer NOT NULL CHECK (height BETWEEN 160 AND 720),
  schema_version integer NOT NULL,
  kit_version integer NOT NULL,
  spec text NOT NULL CHECK (octet_length(spec) <= 131072),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visual_id, version)
);
CREATE INDEX thread_visuals_thread ON thread_visuals(thread_id);
CREATE INDEX thread_visuals_turn ON thread_visuals(turn_id);
