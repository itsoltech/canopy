ALTER TABLE bot_messages ADD COLUMN error_code text NOT NULL DEFAULT '';
ALTER TABLE bot_messages ADD COLUMN error_source text NOT NULL DEFAULT '';
