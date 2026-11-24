-- Each private message has a single eligible reactor, the other participant.
-- Updating the message also records its ID in the existing bot view journal.
ALTER TABLE bot_messages ADD COLUMN reactions text[] NOT NULL DEFAULT '{}';
ALTER TABLE bot_turns ADD COLUMN reaction_input boolean NOT NULL DEFAULT false;

-- Clients resuming a cursor from before this migration need the new eligibility
-- field on historical messages, even on chats that have had no recent activity.
UPDATE bot_view_clock SET epoch = gen_random_uuid();
