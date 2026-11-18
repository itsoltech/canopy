ALTER TABLE bot_channel_messages ADD COLUMN slack_file_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_edited boolean NOT NULL DEFAULT false;
ALTER TABLE attachments ADD COLUMN slack_file_id text;
CREATE UNIQUE INDEX attachments_bot_slack_file ON attachments(bot_turn_id, slack_file_id)
  WHERE slack_file_id IS NOT NULL;
CREATE INDEX bot_channel_messages_input ON bot_channel_messages(input_id) WHERE input_id IS NOT NULL;
