-- GitHub App credentials belong only to this gateway, outside shared configuration.
CREATE TABLE github_accounts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host text NOT NULL DEFAULT 'github.com' CHECK (host = 'github.com'),
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[1-9][0-9]*$'),
  login text NOT NULL,
  auth_kind text NOT NULL CHECK (auth_kind IN ('device', 'pat')),
  connector_account_id uuid,
  connector_revision bigint,
  status text NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  credentials bytea,
  key_id text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  refresh_lease uuid,
  refresh_lease_until timestamptz,
  catalog_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id),
  UNIQUE (owner_user_id, host, github_user_id),
  CHECK ((auth_kind = 'device' AND connector_account_id IS NULL AND connector_revision IS NULL) OR
         (auth_kind = 'pat' AND credentials IS NULL AND connector_account_id IS NOT NULL AND connector_revision IS NOT NULL)),
  CHECK ((credentials IS NULL) = (key_id IS NULL)),
  CHECK ((refresh_lease IS NULL) = (refresh_lease_until IS NULL)),
  CHECK (status = 'connected' OR credentials IS NULL)
);

-- The existing connector schema has a global primary key. The composite key prevents
-- selecting a different owner's connector even if its UUID is known.
ALTER TABLE connector_accounts ADD CONSTRAINT connector_accounts_owner_id UNIQUE (owner_user_id, id);
ALTER TABLE github_accounts ADD CONSTRAINT github_accounts_connector_owner
  FOREIGN KEY (owner_user_id, connector_account_id)
  REFERENCES connector_accounts(owner_user_id, id) ON DELETE CASCADE;

CREATE TABLE github_device_auth (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_binding text NOT NULL,
  client_request_id text NOT NULL,
  client_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'connected', 'expired', 'denied', 'cancelled', 'failed')),
  device_code bytea,
  key_id text,
  user_code text NOT NULL,
  verification_uri text NOT NULL CHECK (verification_uri = 'https://github.com/login/device'),
  expires_at timestamptz NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  next_poll_at timestamptz NOT NULL,
  lease_id uuid,
  lease_until timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, client_binding, client_request_id),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES github_accounts(owner_user_id, id) ON DELETE CASCADE,
  CHECK ((device_code IS NULL) = (key_id IS NULL)),
  CHECK (state = 'pending' OR device_code IS NULL),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE INDEX github_device_auth_due ON github_device_auth(next_poll_at) WHERE state = 'pending';
CREATE INDEX github_device_auth_retention ON github_device_auth(expires_at);

CREATE TABLE github_installations (
  owner_user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]*$'),
  login text NOT NULL,
  account_type text NOT NULL,
  repository_selection text NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'object'),
  suspended boolean NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, account_id, installation_id),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES github_accounts(owner_user_id, id) ON DELETE CASCADE
);

CREATE TABLE github_installation_repositories (
  owner_user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  installation_id text NOT NULL,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]*$'),
  full_name text NOT NULL,
  private boolean NOT NULL,
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'object'),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, account_id, installation_id, repository_id),
  FOREIGN KEY (owner_user_id, account_id, installation_id)
    REFERENCES github_installations(owner_user_id, account_id, installation_id) ON DELETE CASCADE
);
