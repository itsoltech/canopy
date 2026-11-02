-- Trwały cron bota. Soft delete zachowuje pochodzenie transkryptów i kart zgody.
CREATE TABLE bot_routines (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 32000),
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  schedule_text text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  hops integer NOT NULL CHECK (hops BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_outcome text NOT NULL DEFAULT '',
  run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  CHECK (NOT enabled OR deleted_at IS NOT NULL OR next_run_at IS NOT NULL)
);
CREATE INDEX bot_routines_due ON bot_routines(next_run_at) WHERE enabled AND deleted_at IS NULL;
ALTER TABLE bot_turns ADD COLUMN routine_id uuid REFERENCES bot_routines(id);
ALTER TABLE bot_turns ADD COLUMN routine_title text NOT NULL DEFAULT '';
CREATE INDEX bot_turns_routine ON bot_turns(routine_id) WHERE routine_id IS NOT NULL;
-- Czytane są tylko widoczne wiadomości; ukryte uruchomienia nigdy nie przesuwają seq.
ALTER TABLE bots ADD COLUMN last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0);
