-- Accounting is independent of transcript, threads, bots and linked-peer lifecycles.
CREATE TABLE usage_state (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  computer_id text NOT NULL,
  tracking_since timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO usage_state(owner_user_id,computer_id)
SELECT u.id,coalesce(i.node_id,'server:' || u.id::text) FROM users u
LEFT JOIN computer_identity i ON i.owner_user_id=u.id;

CREATE TABLE usage_buckets (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  requested_service_tier text NOT NULL DEFAULT '',
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_write_input_tokens bigint NOT NULL DEFAULT 0,
  reasoning_output_tokens bigint NOT NULL DEFAULT 0,
  reported_cost_usd double precision NOT NULL DEFAULT 0,
  reports bigint NOT NULL DEFAULT 0,
  unknown_cost_reports bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL,
  PRIMARY KEY(owner_user_id,bucket_start,provider,model,requested_service_tier)
);
CREATE INDEX usage_buckets_changes ON usage_buckets(owner_user_id,revision);
-- Compact per-turn/model watermarks permit late corrections without raw event retention.
-- Purging a subject removes its watermarks, but never the independent aggregate buckets.
CREATE TABLE usage_counters (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE CASCADE,
  bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
  thread_turn_id uuid REFERENCES turns(id) ON DELETE CASCADE,
  bot_turn_id uuid REFERENCES bot_turns(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  requested_service_tier text NOT NULL DEFAULT '',
  counter_id text NOT NULL,
  first_bucket timestamptz NOT NULL,
  totals jsonb NOT NULL,
  PRIMARY KEY(owner_user_id,subject_id,provider,model,counter_id)
);
CREATE INDEX usage_counters_turn ON usage_counters(owner_user_id,subject_id,provider,counter_id);
CREATE TABLE remote_usage_buckets (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  bucket_start timestamptz NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  requested_service_tier text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY(owner_user_id,node_id,bucket_start,provider,model,requested_service_tier),
  FOREIGN KEY(owner_user_id,node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE
);
CREATE TABLE remote_usage_state (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  cursor bigint NOT NULL DEFAULT 0,
  has_more boolean NOT NULL DEFAULT true,
  tracking_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,node_id),
  FOREIGN KEY(owner_user_id,node_id) REFERENCES computer_peers(owner_user_id,node_id) ON DELETE CASCADE
);
