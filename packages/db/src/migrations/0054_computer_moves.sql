-- Stage 8: moving threads and bots between directly linked computers.
-- A move is a two-phase operation coordinated by the source (the current home). The source
-- freezes the thing, the target stages its full state, the source commits (the cut-over: its
-- copy becomes a redirect) and the target applies the staged state. Both sides keep a durable
-- record, so either may restart at any phase and the move converges to exactly one home.

-- Frozen for a move (preparing) or moved away (committed): the node id of the new home.
-- No turn may start on a frozen or moved thread or bot, whatever path tries it.
ALTER TABLE threads ADD COLUMN moved_to text;
ALTER TABLE bots ADD COLUMN moved_to text;
-- What a bot that arrived from another computer needs again here (connector accounts, MCP servers).
ALTER TABLE bots ADD COLUMN move_notes jsonb;

CREATE FUNCTION computer_move_guard_turn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  -- KEY SHARE is the lock the foreign key takes anyway. It waits for a freeze in progress
  -- (FOR UPDATE) and then reads the row's latest version.
  SELECT moved_to INTO target FROM threads WHERE id = NEW.thread_id FOR KEY SHARE;
  IF target IS NOT NULL THEN
    RAISE EXCEPTION 'canopy: this thread is moving to another computer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER turns_move_guard BEFORE INSERT ON turns FOR EACH ROW EXECUTE FUNCTION computer_move_guard_turn();
CREATE TRIGGER turn_steers_move_guard BEFORE INSERT ON turn_steers FOR EACH ROW EXECUTE FUNCTION computer_move_guard_turn();

CREATE FUNCTION computer_move_guard_bot_turn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  SELECT moved_to INTO target FROM bots WHERE id = NEW.bot_id FOR KEY SHARE;
  IF target IS NOT NULL THEN
    RAISE EXCEPTION 'canopy: this bot is moving to another computer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bot_turns_move_guard BEFORE INSERT ON bot_turns FOR EACH ROW EXECUTE FUNCTION computer_move_guard_bot_turn();

-- One row per move and side. The peer may be unlinked later: the record stays for the history
-- (no cascade), and unlinking resolves an unfinished move first (docs/linked-computers.md).
CREATE TABLE computer_moves (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('source', 'target')),
  peer_node_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('thread', 'bot')),
  item_id uuid NOT NULL,
  batch_id uuid,
  title text NOT NULL DEFAULT '',
  -- source: preparing → committed → done, or preparing → aborting → aborted.
  -- target: prepared → committed (applying) → done, or prepared → aborted.
  state text NOT NULL CHECK (state IN ('preparing', 'prepared', 'committed', 'done', 'aborting', 'aborted')),
  -- source: the chosen workspace on the target; target: the staged export until it is applied.
  placement jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload bytea,
  -- What the user has to do again on the target (connector accounts, MCP servers, goals).
  redo jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- source only: the frozen schedules of a thread and their next runs, restored by a rollback.
  frozen jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, id),
  CHECK ((role = 'source' AND state IN ('preparing', 'committed', 'done', 'aborting', 'aborted'))
      OR (role = 'target' AND state IN ('prepared', 'committed', 'done', 'aborted'))),
  CHECK (payload IS NULL OR role = 'target')
);
-- At most one unfinished move of a thing on this computer.
CREATE UNIQUE INDEX computer_moves_active ON computer_moves (owner_user_id, item_id)
  WHERE state IN ('preparing', 'prepared', 'committed', 'aborting');
CREATE INDEX computer_moves_recent ON computer_moves (owner_user_id, updated_at DESC);

-- Where a moved thread or bot lives now. Old ids (links, mirrors, agent bus references) resolve
-- through this table; home_node_id may be this computer (the target of a move).
CREATE TABLE computer_redirects (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('thread', 'bot')),
  home_node_id text NOT NULL,
  home_name text NOT NULL DEFAULT '',
  from_node_id text NOT NULL,
  moved_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, item_id)
);

-- The history a moved thread had on its previous home: its last snapshot (ui.ThreadSnapshot,
-- without schedules or secrets). New turns continue after it on this computer.
CREATE TABLE computer_moved_threads (
  thread_id uuid PRIMARY KEY REFERENCES threads(id),
  from_node_id text NOT NULL,
  history bytea NOT NULL,
  -- Reserves the history's turn numbers: new turns start after them.
  ordinal_turn_id uuid NOT NULL,
  moved_at timestamptz NOT NULL DEFAULT now()
);
