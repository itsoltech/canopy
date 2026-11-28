-- Pending migrations share a transaction. Earlier backfills can leave deferred checks queued on rows whose
-- tables this migration alters.
SET CONSTRAINTS ALL IMMEDIATE;

-- Event triggers (docs/bots.md): a bot_routines row of kind 'trigger' runs on matching Canopy events instead of a
-- cron. Its turns keep the routine origin, so delegation, parking and stops behave like routine runs.
ALTER TABLE bot_routines ADD COLUMN kind text NOT NULL DEFAULT 'routine' CHECK (kind IN ('routine', 'trigger'));
ALTER TABLE bot_routines ALTER COLUMN cron DROP NOT NULL;
ALTER TABLE bot_routines ADD COLUMN event text;
ALTER TABLE bot_routines ADD COLUMN filter jsonb;
-- Every change of the filter, the instructions or the enabled state; events and batches belong to one revision.
ALTER TABLE bot_routines ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
-- When the revision last changed: a threshold crossing needs a baseline observed after it.
ALTER TABLE bot_routines ADD COLUMN revised_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bot_routines ADD COLUMN auto_paused boolean NOT NULL DEFAULT false;
-- Consecutive hours in which the trigger hit its turn limit; three pause it.
ALTER TABLE bot_routines ADD COLUMN limit_hits smallint NOT NULL DEFAULT 0 CHECK (limit_hits >= 0);
ALTER TABLE bot_routines ADD COLUMN limit_hour timestamptz;
ALTER TABLE bot_routines DROP CONSTRAINT bot_routines_check;
ALTER TABLE bot_routines ADD CONSTRAINT bot_routines_schedule CHECK (
  kind = 'trigger' OR (cron IS NOT NULL AND (NOT enabled OR deleted_at IS NOT NULL OR next_run_at IS NOT NULL)));
ALTER TABLE bot_routines ADD CONSTRAINT bot_routines_trigger CHECK (
  (kind = 'trigger') = (event IS NOT NULL AND filter IS NOT NULL));

CREATE FUNCTION bot_routines_revised() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revised_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_routines_revised BEFORE UPDATE OF revision ON bot_routines FOR EACH ROW
  WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
  EXECUTE FUNCTION bot_routines_revised();

-- The resources an enabled, unpaused trigger listens to. Rows exist only while it can match, so a source event
-- of an owner without matching scopes costs one index lookup and writes nothing.
CREATE TABLE bot_trigger_scopes (
  trigger_id    uuid NOT NULL REFERENCES bot_routines (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event         text NOT NULL,
  kind          text NOT NULL,
  ref_id        text NOT NULL,
  PRIMARY KEY (trigger_id, kind, ref_id)
);
CREATE INDEX bot_trigger_scopes_lookup ON bot_trigger_scopes (owner_user_id, event, kind, ref_id);

-- An event written in the transaction of its source fact, with the triggers (and revisions) that could match it
-- at that moment. Facts hold ids and catalogue fields only, never message text.
CREATE TABLE bot_trigger_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event         text NOT NULL,
  occurrence    text NOT NULL,
  facts         jsonb NOT NULL,
  context       jsonb NOT NULL DEFAULT '{}',
  candidates    jsonb NOT NULL,
  hops          smallint NOT NULL DEFAULT 0 CHECK (hops >= 0),
  -- The owner's trigger generation when the fact was recorded: a Bots module transition starts a new one.
  generation    bigint NOT NULL DEFAULT 0,
  -- An event waiting for a candidate frozen by a move is looked at again after this time.
  held_until    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A fact shared by several owners (a shared worker's usage) is an event of each of them.
  UNIQUE (owner_user_id, event, occurrence)
);
CREATE INDEX bot_trigger_events_owner ON bot_trigger_events (owner_user_id, created_at);

-- Raised by every Bots module transition, so an event recorded in a transaction that commits after one is dropped.
CREATE TABLE bot_trigger_generations (
  owner_user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  generation    bigint NOT NULL
);

-- A fact reported once per trigger revision (e.g. a usage window and its reset), kept apart from batch history.
CREATE TABLE bot_trigger_receipts (
  trigger_id uuid NOT NULL REFERENCES bot_routines (id) ON DELETE CASCADE,
  revision   integer NOT NULL,
  key        text NOT NULL,
  -- The fact's own end (e.g. a window's reset); without one the receipt lasts as long as the revision.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trigger_id, revision, key)
);

-- Matched events of one trigger revision, coalesced into one turn.
CREATE TABLE bot_trigger_batches (
  id         uuid PRIMARY KEY,
  trigger_id uuid NOT NULL REFERENCES bot_routines (id) ON DELETE CASCADE,
  revision   integer NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'delivered', 'dropped')),
  opened_at  timestamptz NOT NULL,
  matched    integer NOT NULL DEFAULT 0 CHECK (matched >= 0),
  -- Projections of the newest 50 matched events.
  events     jsonb NOT NULL DEFAULT '[]',
  hops       smallint NOT NULL DEFAULT 0 CHECK (hops >= 0),
  turn_id    uuid REFERENCES bot_turns (id),
  -- The trigger's title, filter text and instructions when the batch became a run: its input is rebuilt from them.
  snapshot   jsonb,
  reason     text NOT NULL DEFAULT '',
  closed_at  timestamptz,
  -- A held batch (a running turn, the hourly limit) is not looked at again before this time.
  check_after timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX bot_trigger_batches_open ON bot_trigger_batches (trigger_id) WHERE status = 'open';
CREATE INDEX bot_trigger_batches_closed ON bot_trigger_batches (trigger_id, closed_at) WHERE status <> 'open';

-- Writes an event when an enabled trigger of a live bot lists one of its resources. Source triggers call it.
CREATE FUNCTION bot_trigger_record(p_owner uuid, p_event text, p_occurrence text, p_facts jsonb, p_context jsonb,
  p_hops integer, p_threads boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_owner IS NULL THEN
    RETURN;
  END IF;

  -- One statement, so module eligibility, candidates and generation come from one snapshot.
  INSERT INTO bot_trigger_events (owner_user_id, event, occurrence, facts, context, candidates, hops, generation)
  SELECT p_owner, p_event, p_occurrence, p_facts, p_context, c.found, greatest(p_hops, 0),
    coalesce((SELECT g.generation FROM bot_trigger_generations g WHERE g.owner_user_id = p_owner), 0)
  FROM (
    -- Each resource of the event is one lookup of the scope index.
    SELECT jsonb_agg(DISTINCT jsonb_build_object('id', r.id, 'revision', r.revision)) AS found
    FROM jsonb_each_text(coalesce(p_facts -> 'scope', '{}'::jsonb)) f(kind, ref_id)
      JOIN bot_trigger_scopes s ON s.owner_user_id = p_owner AND s.event = p_event AND s.kind = f.kind
        AND s.ref_id = f.ref_id
      JOIN bot_routines r ON r.id = s.trigger_id JOIN bots b ON b.id = r.bot_id
    WHERE r.enabled AND NOT r.auto_paused AND r.deleted_at IS NULL
      AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
  ) c
  WHERE c.found IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_settings WHERE user_id = p_owner AND (
      NOT (coalesce(settings #> '{modules,enabled}', '["threads","bots"]'::jsonb) ? 'bots')
      OR (p_threads AND NOT (coalesce(settings #> '{modules,enabled}', '["threads","bots"]'::jsonb) ? 'threads'))))
  ON CONFLICT (owner_user_id, event, occurrence) DO NOTHING;
END
$$;
