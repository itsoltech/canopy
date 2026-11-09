-- Szkice kompozytora są prywatne i współdzielone przez urządzenia właściciela.
CREATE TABLE bot_composer_drafts (
  bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  payload bytea NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

ALTER TABLE attachments ADD COLUMN bot_id uuid REFERENCES bots(id);
ALTER TABLE attachments ADD COLUMN bot_turn_id uuid REFERENCES bot_turns(id);
ALTER TABLE attachments ADD CONSTRAINT attachments_bot_bound_together
  CHECK ((bot_id IS NULL) = (bot_turn_id IS NULL));
ALTER TABLE attachments ADD CONSTRAINT attachments_one_conversation
  CHECK (thread_id IS NULL OR bot_id IS NULL);
CREATE INDEX attachments_bot_turn ON attachments(bot_turn_id) WHERE bot_turn_id IS NOT NULL;
ALTER TABLE bot_messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
