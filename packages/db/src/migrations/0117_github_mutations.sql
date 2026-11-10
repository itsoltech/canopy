CREATE TABLE github_mutation_receipts (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  client_binding text NOT NULL,
  fingerprint text NOT NULL,
  action text NOT NULL,
  access_revision bigint NOT NULL,
  mapping_revision bigint NOT NULL,
  head_sha text NOT NULL,
  expected_state text NOT NULL,
  resource_id text NOT NULL DEFAULT '',
  path text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','in_flight','succeeded','failed','uncertain')),
  confirmation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '60 seconds',
  lease_until timestamptz,
  upstream_id text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  viewer_viewed_state text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id,request_id),
  FOREIGN KEY (owner_user_id,account_id) REFERENCES github_accounts(owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id,pull_request_id) REFERENCES github_pull_requests(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX github_mutation_in_flight ON github_mutation_receipts(lease_until) WHERE state='in_flight';
ALTER TABLE github_api_budgets ADD COLUMN last_mutation_at timestamptz;
