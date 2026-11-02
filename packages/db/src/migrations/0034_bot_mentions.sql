-- 0033 is reserved for the concurrent bot settings change.
ALTER TABLE bot_messages ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bot_messages ADD COLUMN quotes jsonb NOT NULL DEFAULT '[]'::jsonb;
