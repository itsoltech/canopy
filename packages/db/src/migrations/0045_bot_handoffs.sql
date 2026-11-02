-- A handoff uses the bot FIFO/lease/checkpoint machinery, but never emits chat.
-- Configuration contains model settings only, never endpoint credentials.
ALTER TABLE bot_turns ADD COLUMN handoff_configuration jsonb;
ALTER TABLE bot_turns ADD COLUMN handoff_instance_label text;
ALTER TABLE bot_turns ADD COLUMN handoff_deadline timestamptz;
ALTER TABLE bot_turns ADD CONSTRAINT bot_turns_hidden_origin CHECK (
  handoff_configuration IS NULL OR (routine_id IS NULL AND reply_to_bot_id IS NULL)
);
CREATE UNIQUE INDEX bot_turns_one_handoff ON bot_turns(bot_id)
  WHERE handoff_configuration IS NOT NULL AND status IN ('queued', 'running', 'waiting');

CREATE TABLE bot_handoff_notes (
  turn_id uuid PRIMARY KEY REFERENCES bot_turns(id),
  bot_id uuid NOT NULL REFERENCES bots(id),
  model text NOT NULL,
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 32000),
  fallback_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_handoff_notes_latest ON bot_handoff_notes(bot_id, created_at DESC, turn_id DESC);
