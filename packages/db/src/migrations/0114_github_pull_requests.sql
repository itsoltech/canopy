ALTER TABLE threads ADD CONSTRAINT threads_owner_id UNIQUE (owner_user_id,id);
ALTER TABLE threads ADD COLUMN newest_pull_request jsonb;
ALTER TABLE threads ADD COLUMN pull_request_count integer NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN pull_request_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE github_repository_accounts (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  repository_name text NOT NULL,
  account_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_user_id,repository_id),
  FOREIGN KEY (owner_user_id,account_id) REFERENCES github_accounts(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX github_repository_accounts_name ON github_repository_accounts(owner_user_id,lower(repository_name));

CREATE TABLE github_pull_requests (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host text NOT NULL DEFAULT 'github.com' CHECK (host='github.com'),
  repository_id text NOT NULL,
  repository_name text NOT NULL,
  number integer NOT NULL CHECK (number>0),
  node_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (owner_user_id,id),
  UNIQUE (owner_user_id,host,repository_id,number)
);
CREATE TABLE thread_pull_requests (
  owner_user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('manual','auto')),
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  PRIMARY KEY (owner_user_id,thread_id,pull_request_id),
  FOREIGN KEY (owner_user_id,thread_id) REFERENCES threads(owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id,pull_request_id) REFERENCES github_pull_requests(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX thread_pull_requests_pr ON thread_pull_requests(owner_user_id,pull_request_id) WHERE unlinked_at IS NULL;

-- Private content is scoped to one owner/account/access revision. Leases never hold a SQL transaction over HTTP.
CREATE TABLE github_pr_cache (
  owner_user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  access_revision bigint NOT NULL,
  cache_key text NOT NULL,
  payload jsonb,
  generation bigint NOT NULL DEFAULT 0,
  etag text NOT NULL DEFAULT '',
  verified_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  PRIMARY KEY (owner_user_id,account_id,access_revision,cache_key),
  FOREIGN KEY (owner_user_id,account_id) REFERENCES github_accounts(owner_user_id,id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX github_pr_cache_retention ON github_pr_cache(owner_user_id,last_read_at);

-- Accounting is shared by GitHub identity, without storing private response data here.
CREATE TABLE github_api_budgets (
  github_user_id text NOT NULL,
  resource text NOT NULL CHECK (resource IN ('core','graphql')),
  window_at timestamptz NOT NULL DEFAULT now(),
  used integer NOT NULL DEFAULT 0,
  remaining integer NOT NULL DEFAULT 5000,
  limit_count integer NOT NULL DEFAULT 5000,
  reset_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
  retry_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY (github_user_id,resource)
);
CREATE TABLE github_api_slots (
  slot integer PRIMARY KEY CHECK (slot IN (0,1)),
  github_user_id text UNIQUE,
  lease_id uuid,
  lease_until timestamptz
);
INSERT INTO github_api_slots(slot) VALUES (0),(1);
