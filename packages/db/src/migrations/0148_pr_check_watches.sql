-- CI check watches (docs/agent-bus.md, "Checki CI"): an agent watches the checks of a pull request linked to its
-- thread (watch_pr_checks). The gateway polls with the owner's GitHub account and follows new commits; what the agent
-- should hear becomes a note, delivered like background task notes (0024): a steer of the running turn, else a turn
-- of its own (trigger pr_checks).
CREATE TABLE pr_check_watches (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  thread_id       uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  -- The watch_pr_checks call: a re-sent call finds its watch.
  call_id         uuid NOT NULL UNIQUE,
  notify_on       text[] NOT NULL CHECK (cardinality(notify_on) BETWEEN 1 AND 3
                    AND notify_on <@ ARRAY['failure', 'complete', 'each']),
  -- Hops of the watch's notes: the calling turn's + 1, + 1 per followed commit (an agent pushing fixes in a loop
  -- stops waking at the hop limit).
  hops            smallint NOT NULL CHECK (hops BETWEEN 1 AND 16),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  -- passed | merged | closed | timeout | no_checks | access | unlinked (with a note); cancelled | replaced | thread_closed
  end_reason      text,
  expires_at      timestamptz NOT NULL,
  -- Progress for the current head: final states already judged by check key, and whether its checks all finished.
  head_sha        text NOT NULL,
  head_seen_at    timestamptz NOT NULL DEFAULT now(),
  head_changes    smallint NOT NULL DEFAULT 0,
  head_changed    boolean NOT NULL DEFAULT false,
  seen            jsonb NOT NULL DEFAULT '{}',
  settled         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  FOREIGN KEY (owner_user_id, thread_id) REFERENCES threads (owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, pull_request_id) REFERENCES github_pull_requests (owner_user_id, id) ON DELETE CASCADE,
  CONSTRAINT pr_check_watches_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL AND end_reason IS NOT NULL))
);
CREATE INDEX pr_check_watches_active ON pr_check_watches (owner_user_id) WHERE status = 'active';
CREATE INDEX pr_check_watches_thread ON pr_check_watches (thread_id, created_at DESC);

--   waiting -> steering (steer_id) -> delivered | delivered (a turn of its own: turn_id) | cancelled.
-- A steer that does not join goes back to waiting. wake = false (hop limit): the note joins the next turn that runs.
CREATE TABLE pr_check_notes (
  id         uuid PRIMARY KEY,
  watch_id   uuid NOT NULL REFERENCES pr_check_watches (id) ON DELETE CASCADE,
  thread_id  uuid NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  body       jsonb NOT NULL,
  wake       boolean NOT NULL,
  hops       smallint NOT NULL CHECK (hops BETWEEN 1 AND 16),
  status     text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'steering', 'delivered', 'cancelled')),
  steer_id   uuid REFERENCES turn_steers (id),
  turn_id    uuid,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (turn_id, thread_id) REFERENCES turns (id, thread_id),
  CONSTRAINT pr_check_notes_steering CHECK ((status = 'steering') = (steer_id IS NOT NULL) OR status = 'delivered')
);
CREATE INDEX pr_check_notes_waiting ON pr_check_notes (thread_id, created_at) WHERE status = 'waiting';
CREATE INDEX pr_check_notes_steer ON pr_check_notes (steer_id) WHERE steer_id IS NOT NULL;

ALTER TABLE turns DROP CONSTRAINT turns_trigger_check;
ALTER TABLE turns ADD CONSTRAINT turns_trigger_check CHECK (trigger IN ('user','agent_bus','schedule','interaction','goal','provider','recovery','background_task','bot','linked_agent','import','pr_checks'));
ALTER TABLE turns DROP CONSTRAINT turns_hops_by_trigger;
ALTER TABLE turns ADD CONSTRAINT turns_hops_by_trigger CHECK (
  (trigger IN ('user','goal','provider','recovery','import') AND hops = 0)
  OR (trigger IN ('agent_bus','background_task','bot','linked_agent','pr_checks') AND hops > 0)
  OR trigger IN ('schedule','interaction')
);

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'import_image_reply', 'render_visual', 'render_html',
  'watch_pr_checks', 'list_pr_watches', 'cancel_pr_watch'
)) NOT VALID;
