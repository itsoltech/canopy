CREATE SEQUENCE agent_memory_revision;

CREATE TABLE agent_memory_scopes (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  worker_id uuid REFERENCES workers(id) ON DELETE CASCADE,
  bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES bot_channel_conversations(id) ON DELETE CASCADE,
  scope_key text GENERATED ALWAYS AS (
    CASE WHEN worker_id IS NOT NULL THEN 'worker:' || project_id::text || ':' || worker_id::text
         WHEN project_id IS NOT NULL THEN 'project:' || project_id::text
         WHEN conversation_id IS NOT NULL THEN 'conversation:' || bot_id::text || ':' || conversation_id::text
         ELSE 'bot:' || bot_id::text END
  ) STORED,
  revision bigint NOT NULL DEFAULT nextval('agent_memory_revision'),
  CHECK ((project_id IS NOT NULL AND bot_id IS NULL AND conversation_id IS NULL)
      OR (bot_id IS NOT NULL AND project_id IS NULL AND worker_id IS NULL)),
  PRIMARY KEY (owner_user_id, scope_key)
);

CREATE TABLE agent_memory_notes (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  scope_key text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160 AND title ~ '[^[:space:]]'),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000 AND body ~ '[^[:space:]]'),
  aliases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases) <= 8),
  pinned boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_kind text CHECK (source_kind IN ('thread','bot')),
  source_id uuid,
  source_turn_id uuid,
  CHECK (num_nonnulls(source_kind, source_id, source_turn_id) IN (0,3)),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_user_id, scope_key) REFERENCES agent_memory_scopes ON DELETE CASCADE
);
CREATE INDEX agent_memory_notes_scope ON agent_memory_notes(owner_user_id, scope_key, updated_at DESC, id DESC);
CREATE INDEX agent_memory_notes_owner ON agent_memory_notes(owner_user_id, updated_at DESC, id DESC);

-- Receipts survive note deletion so redelivery cannot recreate forgotten content.
CREATE TABLE agent_memory_operations (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  note_id uuid NOT NULL,
  note_revision integer NOT NULL,
  PRIMARY KEY (owner_user_id, operation_id)
);
