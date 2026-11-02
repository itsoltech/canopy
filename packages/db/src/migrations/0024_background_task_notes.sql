-- Background tasks the agent hears about (docs/execution.md, "Pobudka"): every end of a background task (completed,
-- failed, stopped by the system, killed by a worker shutdown or lost in a crash) reaches the thread's agent as a
-- platform note, because Codex never wakes up for it and Claude only after a completion.

-- One note per task, written by Ingest in the same transaction as the item's end (so it survives a gateway restart
-- and a re-sent end does not make a second one). Delivered by the gateway (core/background-notes.ts):
--   waiting   -> steering (a steer of the running turn: steer_id) -> delivered (it joined the turn)
--             -> delivered (a turn of its own: turn_id, trigger background_task)
--             -> harness (Claude woke up for it itself) | cancelled (the thread is archived).
-- A steer that does not join goes back to waiting. wake = false (stopped by the user, or the agent chain is at its
-- hop limit): no turn of its own, the note joins the next turn that runs.
CREATE TABLE background_task_notes (
  thread_id         uuid NOT NULL,
  item_id           text NOT NULL,
  status            text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'steering', 'delivered', 'harness', 'cancelled')),
  wake              boolean NOT NULL,
  -- Claude starts a turn itself after a task it saw complete: the gateway waits a little (from ended_at) and checks
  -- whether it did before it wakes the thread.
  harness_wakes     boolean NOT NULL DEFAULT false,
  ended_at          timestamptz NOT NULL,
  -- Hops of the note's turn: the hops of the turn that started the task + 1 (a task restarting itself stops at the limit).
  hops              smallint NOT NULL CHECK (hops BETWEEN 1 AND 16),
  turn_id           uuid,
  steer_id          uuid REFERENCES turn_steers (id),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, item_id),
  FOREIGN KEY (thread_id, item_id) REFERENCES thread_items (thread_id, item_id),
  FOREIGN KEY (turn_id, thread_id) REFERENCES turns (id, thread_id),
  CONSTRAINT background_task_notes_steering CHECK ((status = 'steering') = (steer_id IS NOT NULL) OR status = 'delivered')
);
CREATE INDEX background_task_notes_waiting ON background_task_notes (ended_at) WHERE status = 'waiting';
CREATE INDEX background_task_notes_turn ON background_task_notes (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX background_task_notes_steer ON background_task_notes (steer_id) WHERE steer_id IS NOT NULL;

-- The note's own turn.
ALTER TABLE turns DROP CONSTRAINT turns_trigger_check;
ALTER TABLE turns ADD CONSTRAINT turns_trigger_check
  CHECK (trigger IN ('user', 'agent_bus', 'schedule', 'interaction', 'goal', 'provider', 'recovery', 'background_task'));
ALTER TABLE turns DROP CONSTRAINT turns_hops_by_trigger;
ALTER TABLE turns ADD CONSTRAINT turns_hops_by_trigger CHECK (
  (trigger IN ('user', 'goal', 'provider', 'recovery') AND hops = 0)
  OR (trigger IN ('agent_bus', 'background_task') AND hops > 0)
  OR trigger IN ('schedule', 'interaction')
);

-- A note steered into the running turn has no author: it is the platform's.
ALTER TABLE turn_steers ADD COLUMN background_note boolean NOT NULL DEFAULT false;
ALTER TABLE turn_steers DROP CONSTRAINT turn_steers_author;
ALTER TABLE turn_steers ADD CONSTRAINT turn_steers_author CHECK (
  CASE WHEN background_note THEN author_user_id IS NULL AND agent_call_id IS NULL
       ELSE (author_user_id IS NULL) <> (agent_call_id IS NULL) END
);

-- The turn's source for the UI: the tasks its note is about.
CREATE OR REPLACE VIEW turn_sources AS
SELECT u.id AS turn_id,
       CASE
         WHEN tc.id IS NOT NULL THEN CASE tc.tool WHEN 'spawn_thread' THEN 'task' ELSE 'message' END
         WHEN nc.id IS NOT NULL THEN 'report'
         WHEN u.interaction_request_id IS NOT NULL THEN 'question'
         WHEN u.schedule_id IS NOT NULL THEN 'schedule'
         WHEN u.trigger = 'background_task' THEN 'background_task'
       END AS source_kind,
       coalesce(tc.source_thread_id, nc.target_thread_id, ir.thread_id, sc.source_thread_id) AS source_thread_id,
       rt.status AS source_status,
       ir.kind AS question_kind,
       ir.tool_name AS question_tool,
       CASE WHEN u.trigger = 'background_task'
            THEN ARRAY(SELECT n.item_id FROM background_task_notes n WHERE n.turn_id = u.id ORDER BY n.ended_at, n.item_id)
       END AS background_item_ids
  FROM turns u
  LEFT JOIN agent_bus_calls tc ON tc.id = u.agent_call_id AND tc.target_turn_id = u.id
  LEFT JOIN agent_bus_calls nc ON nc.id = u.agent_call_id AND nc.notified_turn_id = u.id
  LEFT JOIN turns rt ON rt.id = nc.target_turn_id
  LEFT JOIN interaction_requests ir ON ir.id = u.interaction_request_id
  LEFT JOIN schedules s ON s.id = u.schedule_id
  LEFT JOIN agent_bus_calls sc ON sc.id = s.created_by_call_id;

-- The agent's tools for its background tasks (docs/agent-bus.md, "Zadania w tle"). New rows only, like 0011.
ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (
  tool IN ('list_agents', 'spawn_thread', 'send_message', 'wait_threads',
           'get_thread', 'read_thread', 'list_threads', 'interrupt_thread', 'close_thread',
           'list_interactions', 'answer_interaction',
           'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
           'list_background_tasks', 'get_background_task', 'stop_background_task')
) NOT VALID;
