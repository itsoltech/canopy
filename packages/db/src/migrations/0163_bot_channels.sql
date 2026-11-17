-- Poświadczenia Socket Mode są odrębne od kont Slack MCP i nigdy nie opuszczają gatewaya.
CREATE TABLE messenger_accounts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'slack' CHECK (provider = 'slack'),
  external_id text NOT NULL,
  credentials bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'connecting',
  lease_holder text,
  lease_token uuid,
  lease_until timestamptz,
  deleted_at timestamptz,
  UNIQUE(id, owner_user_id)
);
CREATE UNIQUE INDEX messenger_account_workspace ON messenger_accounts(owner_user_id, provider, external_id)
  WHERE deleted_at IS NULL;
CREATE TABLE bot_channel_routes (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bots(id),
  account_id uuid NOT NULL,
  channel_ids text[] NOT NULL DEFAULT '{}',
  user_ids text[] NOT NULL DEFAULT '{}',
  direct_messages boolean NOT NULL DEFAULT false,
  mentions boolean NOT NULL DEFAULT true,
  observe boolean NOT NULL DEFAULT false,
  delivery text NOT NULL DEFAULT 'reply' CHECK (delivery IN ('reply', 'notify')),
  instructions text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  FOREIGN KEY(account_id, owner_user_id) REFERENCES messenger_accounts(id, owner_user_id)
);
CREATE UNIQUE INDEX bot_channel_route_binding ON bot_channel_routes(bot_id, account_id) WHERE deleted_at IS NULL;
CREATE TABLE bot_channel_conversations (
  id uuid PRIMARY KEY,
  route_id uuid NOT NULL REFERENCES bot_channel_routes(id),
  channel_id text NOT NULL,
  thread_id text NOT NULL,
  open_until timestamptz NOT NULL,
  root_author_id text,
  first_received_at timestamptz,
  last_received_at timestamptz,
  last_dispatched_at timestamptz,
  UNIQUE(route_id, channel_id, thread_id)
);
ALTER TABLE bot_turns ADD COLUMN conversation_id uuid REFERENCES bot_channel_conversations(id);
CREATE INDEX bot_turns_external_conversation ON bot_turns(conversation_id, created_at, id)
  WHERE conversation_id IS NOT NULL;
CREATE TABLE messenger_events (
  account_id uuid NOT NULL REFERENCES messenger_accounts(id),
  event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY(account_id, event_id)
);
-- Wiadomości zachowują autora i kolejność odbioru; czas dostawcy to wyłącznie kontekst.
CREATE TABLE bot_channel_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES bot_channel_conversations(id),
  message_id text NOT NULL,
  source_message_id text NOT NULL,
  author_id text NOT NULL,
  text text NOT NULL,
  provider_timestamp text NOT NULL,
  received_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'buffered' CHECK(state IN ('buffered','attempted','consumed')),
  input_id uuid,
  UNIQUE(conversation_id, message_id)
);
CREATE INDEX bot_channel_messages_buffer ON bot_channel_messages(conversation_id, id) WHERE state = 'buffered';
CREATE TABLE bot_channel_inputs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES bot_channel_conversations(id),
  turn_id uuid NOT NULL REFERENCES bot_turns(id),
  text text NOT NULL,
  status text NOT NULL CHECK(status IN ('attempted','applied','dropped','unconfirmed'))
);
CREATE TABLE messenger_outbound (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES messenger_accounts(id),
  conversation_id uuid NOT NULL REFERENCES bot_channel_conversations(id),
  turn_id uuid NOT NULL UNIQUE REFERENCES bot_turns(id),
  channel_id text NOT NULL,
  thread_id text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','failed')),
  lease_token uuid,
  available_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messenger_outbound_due ON messenger_outbound(account_id, available_at) WHERE status = 'pending';
