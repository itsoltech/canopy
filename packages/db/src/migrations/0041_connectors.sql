-- Konta MCP należą do użytkownika. Poświadczenia pozostają w gateway.
CREATE TABLE connector_accounts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  connector_type text NOT NULL,
  name text NOT NULL,
  namespace text NOT NULL UNIQUE,
  url text NOT NULL CHECK (url ~ '^https?://'),
  transport text NOT NULL CHECK (transport IN ('http','sse')),
  auth_kind text NOT NULL CHECK (auth_kind IN ('headers','oauth')),
  credentials bytea,
  key_id text NOT NULL DEFAULT 'env-v1',
  legacy_headers jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('connected','needs_reconnect','error','disconnected')),
  all_workers boolean NOT NULL DEFAULT false,
  all_bots boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  tools jsonb NOT NULL DEFAULT '[]',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_accounts_owner ON connector_accounts(owner_user_id);
CREATE TABLE connector_worker_grants (
  account_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id, worker_id)
);
CREATE TABLE connector_bot_grants (
  account_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id, bot_id)
);
CREATE TABLE connector_oauth_apps (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  connector_type text NOT NULL,
  credentials bytea NOT NULL,
  PRIMARY KEY(owner_user_id, connector_type)
);
CREATE TABLE connector_oauth_states (
  state_hash text PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  browser_hash text NOT NULL,
  credentials bytea NOT NULL,
  account_revision bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
-- Deduplikacja zdalnych efektów. Argumenty nie są utrwalane; hash wiąże call ID.
CREATE TABLE connector_executions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES connector_accounts(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  thread_id uuid REFERENCES threads(id),
  bot_id uuid REFERENCES bots(id),
  tool text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','error')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (num_nonnulls(thread_id,bot_id) = 1)
);
CREATE TABLE connector_audit (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES connector_accounts(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  worker_id uuid REFERENCES workers(id),
  thread_id uuid REFERENCES threads(id),
  bot_id uuid REFERENCES bots(id),
  tool text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,legacy_headers,status,created_at)
SELECT id,owner_user_id,'custom',name,'custom_' || replace(id::text,'-',''),url,transport,'headers',headers,
       CASE WHEN enabled THEN 'connected' ELSE 'disconnected' END,created_at FROM bot_mcp_servers;
INSERT INTO connector_bot_grants(account_id,bot_id)
SELECT c.server_id,c.bot_id FROM bot_mcp_connections c JOIN bots b ON b.id=c.bot_id
JOIN connector_accounts a ON a.id=c.server_id AND a.owner_user_id=b.owner_user_id;
