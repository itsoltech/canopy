-- 0033 is reserved for the concurrent bot settings change.
ALTER TABLE bot_messages ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb;
