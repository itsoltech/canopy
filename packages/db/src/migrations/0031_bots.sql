-- Boty mają jedną rozmowę bez projektu i workera. Osobne tabele nie zmieniają
-- niezmienników threads (projekt, główny/boczny, placement, fork, agent-bus).
CREATE TABLE bots (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL,
  configuration jsonb NOT NULL,
  provider text NOT NULL CHECK (provider IN ('claude', 'codex')),
  provider_instance text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  status_line text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Jak ustawienia wątku: usunięcie instancji nie usuwa historii rozmowy.
  UNIQUE(owner_user_id, client_request_id)
);
CREATE TABLE bot_mcp_servers (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  url text NOT NULL CHECK (url ~ '^https?://'),
  transport text NOT NULL CHECK (transport IN ('http', 'sse')),
  enabled boolean NOT NULL DEFAULT true,
  headers jsonb NOT NULL DEFAULT '{}', -- nazwa -> secretRef
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bot_mcp_connections (
  bot_id uuid NOT NULL REFERENCES bots(id),
  server_id uuid NOT NULL REFERENCES bot_mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY(bot_id, server_id)
);
CREATE TABLE bot_turns (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id),
  client_request_id text NOT NULL,
  input text NOT NULL,
  hops integer NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 8),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','completed','failed','interrupted')),
  checkpoint jsonb NOT NULL DEFAULT '[]',
  lease_token uuid,
  lease_until timestamptz,
  reply_to_bot_id uuid REFERENCES bots(id),
  exchange_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(bot_id, client_request_id)
);
CREATE INDEX bot_turns_pending ON bot_turns(created_at) WHERE status IN ('queued','running','waiting');
CREATE TABLE bot_messages (
  id uuid PRIMARY KEY,
  seq bigserial UNIQUE,
  bot_id uuid NOT NULL REFERENCES bots(id),
  turn_id uuid NOT NULL REFERENCES bot_turns(id),
  message_key text NOT NULL,
  sender_id text NOT NULL,
  recipient_id text NOT NULL,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','event')),
  text text NOT NULL,
  exchange_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(turn_id, message_key)
);
CREATE INDEX bot_messages_conversation ON bot_messages(bot_id, seq);
CREATE INDEX bot_messages_exchange ON bot_messages(exchange_id, seq) WHERE exchange_id IS NOT NULL;
CREATE TABLE bot_tool_calls (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES bot_turns(id),
  call_key text NOT NULL,
  tool jsonb NOT NULL, -- zapis schematu i pochodzenia: polityka nie ufa nazwie modelu
  arguments jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','interrupted')),
  result jsonb,
  UNIQUE(turn_id, call_key)
);
CREATE TABLE bot_approvals (
  id uuid PRIMARY KEY REFERENCES bot_tool_calls(id),
  bot_id uuid NOT NULL REFERENCES bots(id),
  turn_id uuid NOT NULL REFERENCES bot_turns(id),
  kind text NOT NULL CHECK (kind IN ('approval','question')),
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','discarded')),
  answer text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE TABLE bot_thread_watches (
  call_id uuid PRIMARY KEY REFERENCES bot_tool_calls(id),
  bot_id uuid NOT NULL REFERENCES bots(id),
  target_thread_id uuid NOT NULL REFERENCES threads(id),
  target_turn_id uuid REFERENCES turns(id),
  target_steer_id uuid REFERENCES turn_steers(id),
  hops integer NOT NULL CHECK (hops BETWEEN 1 AND 8),
  delivered boolean NOT NULL DEFAULT false
);
-- Tury uruchomione przez bota zachowują hops również po wejściu na szynę workerów.
ALTER TABLE turns ADD COLUMN bot_call_id uuid REFERENCES bot_tool_calls(id);
ALTER TABLE turns DROP CONSTRAINT turns_trigger_check;
ALTER TABLE turns ADD CONSTRAINT turns_trigger_check CHECK (trigger IN ('user','agent_bus','schedule','interaction','goal','provider','recovery','background_task','bot'));
ALTER TABLE turns DROP CONSTRAINT turns_hops_by_trigger;
ALTER TABLE turns ADD CONSTRAINT turns_hops_by_trigger CHECK (
  (trigger IN ('user','goal','provider','recovery') AND hops = 0)
  OR (trigger IN ('agent_bus','background_task','bot') AND hops > 0)
  OR trigger IN ('schedule','interaction')
);
ALTER TABLE turns ADD CONSTRAINT turns_bot_call CHECK ((trigger = 'bot') = (bot_call_id IS NOT NULL));
ALTER TABLE turn_steers ADD COLUMN bot_call_id uuid REFERENCES bot_tool_calls(id);
ALTER TABLE turn_steers DROP CONSTRAINT turn_steers_author;
ALTER TABLE turn_steers ADD CONSTRAINT turn_steers_author CHECK (
  CASE WHEN background_note THEN num_nonnulls(author_user_id, agent_call_id, notification_call_id, bot_call_id) = 0
       ELSE num_nonnulls(author_user_id, agent_call_id, notification_call_id, bot_call_id) = 1 END
);
-- Własne pobudki bota; harmonogramy pracy workerów nadal używają schedules.
CREATE TABLE bot_wakeups (
  id uuid PRIMARY KEY REFERENCES bot_tool_calls(id),
  bot_id uuid NOT NULL REFERENCES bots(id),
  prompt text NOT NULL,
  run_at timestamptz NOT NULL,
  hops integer NOT NULL CHECK (hops BETWEEN 1 AND 8),
  cancelled boolean NOT NULL DEFAULT false,
  delivered boolean NOT NULL DEFAULT false
);
