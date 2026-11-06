CREATE TABLE bot_approval_rules (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  target_id text NOT NULL DEFAULT '',
  tool_name text NOT NULL DEFAULT '',
  label text NOT NULL,
  source text NOT NULL CHECK (source = 'approval_card'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX bot_approval_rules_active
  ON bot_approval_rules(bot_id, kind, target_id, tool_name) WHERE revoked_at IS NULL;
ALTER TABLE bot_approvals ADD COLUMN rule_options jsonb NOT NULL DEFAULT '[]';
ALTER TABLE bot_approvals ADD COLUMN allowed_by_rule jsonb;

-- Only threads actually created by a bot, never threads it merely watches/messages.
CREATE TABLE bot_started_threads (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  use_bot_rules boolean NOT NULL DEFAULT false
);
ALTER TABLE interaction_requests ADD COLUMN allowed_by_bot_rule jsonb;
