-- Desktop → server migration, stage 1 (docs/desktop-server-migration.md §5, §10): durable sessions on both
-- gateways, per-home invitations and their mutual-TLS session credentials, and the empty-target reservation.
-- No migrated data lives here. Secrets: the invitation is stored as a SHA-256 hash and the source's session
-- private key only encrypted with that gateway's secrets key.
CREATE TABLE server_migration_sessions (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- target: the server that imports; source: a desktop home that exports.
  role            text NOT NULL CHECK (role IN ('target', 'source')),
  -- The whole lifecycle of the design, so later stages add transitions and no constraint changes.
  state           text NOT NULL CHECK (state IN ('invited', 'pairing', 'paired', 'preflight', 'copying', 'freezing',
                    'verified', 'prepared', 'committed', 'activating', 'done', 'paused', 'blocked', 'aborting',
                    'aborted', 'recovering')),
  generation      integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  -- The build, schema and protocol this gateway pinned for the session; a different one needs a new preflight.
  protocol        integer NOT NULL,
  build_version   text NOT NULL,
  schema_version  text NOT NULL,
  closed_reason   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);

-- One open session per owner and role: a server imports one group of homes, a home moves to one server.
CREATE UNIQUE INDEX server_migration_sessions_open ON server_migration_sessions (owner_user_id, role)
  WHERE state NOT IN ('aborted', 'done');

-- Target side: one row per invited home. Each home pairs with its own one-time code.
CREATE TABLE server_migration_sources (
  id                    uuid PRIMARY KEY,
  session_id            uuid NOT NULL REFERENCES server_migration_sessions (id) ON DELETE CASCADE,
  owner_user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  invitation_hash       text NOT NULL,
  invitation_expires_at timestamptz NOT NULL,
  invitation_attempts   integer NOT NULL DEFAULT 0,
  exchanged_at          timestamptz,
  -- Proven by the home's computer certificate signing the exchange; the owner id is the home's own.
  source_node_id        text,
  source_name           text NOT NULL DEFAULT '',
  source_owner_id       uuid,
  source_build          text NOT NULL DEFAULT '',
  source_schema         text NOT NULL DEFAULT '',
  -- The home's session certificate: the only credential of the migration channel (mutual TLS).
  certificate           text,
  certificate_pin       text UNIQUE,
  credential_expires_at timestamptz,
  confirmed_at          timestamptz,
  negotiated_at         timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((exchanged_at IS NULL) = (certificate_pin IS NULL)),
  CHECK ((exchanged_at IS NULL) = (source_node_id IS NULL))
);

CREATE INDEX server_migration_sources_session ON server_migration_sources (owner_user_id, session_id);
-- A home pairs once per session; a second pairing needs the first revoked.
CREATE UNIQUE INDEX server_migration_sources_home ON server_migration_sources (session_id, source_node_id)
  WHERE source_node_id IS NOT NULL AND revoked_at IS NULL;

-- Source side: the server this home moves to and the home's own session credential.
CREATE TABLE server_migration_targets (
  session_id            uuid PRIMARY KEY REFERENCES server_migration_sessions (id) ON DELETE CASCADE,
  owner_user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id             uuid NOT NULL,
  origins               text[] NOT NULL,
  target_fingerprint    text NOT NULL,
  target_node_id        text NOT NULL DEFAULT '',
  target_name           text NOT NULL DEFAULT '',
  target_owner_id       uuid,
  target_build          text NOT NULL DEFAULT '',
  target_schema         text NOT NULL DEFAULT '',
  certificate           text NOT NULL,
  certificate_pin       text NOT NULL,
  private_key           bytea NOT NULL,
  key_id                text NOT NULL,
  credential_expires_at timestamptz NOT NULL,
  exchanged_at          timestamptz,
  confirmed_at          timestamptz,
  negotiated_at         timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- The empty-target reservation (§3): while a server imports, no new root data is admitted, from any client
-- or background job. A never-paired invitation stops reserving the server when it expires.
CREATE FUNCTION server_migration_target_reserved() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM server_migration_sessions s
    WHERE s.role = 'target' AND s.state NOT IN ('aborted', 'done')
      AND (s.state <> 'invited' OR EXISTS (
        SELECT 1 FROM server_migration_sources x
        WHERE x.session_id = s.id AND x.revoked_at IS NULL AND x.invitation_expires_at > now()))
  )
$$;

CREATE FUNCTION server_migration_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF server_migration_target_reserved() THEN
    RAISE EXCEPTION 'Importing from desktop. Changes are paused.' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

DO $$
DECLARE
  fenced text;
BEGIN
  FOREACH fenced IN ARRAY ARRAY['threads', 'bots', 'workers', 'enrollment_tokens', 'worker_enrollments', 'secrets',
    'agents', 'schedules', 'connector_accounts', 'connector_oauth_apps', 'github_accounts', 'proxies',
    'agent_skills', 'agent_plugins', 'agent_marketplaces', 'instruction_documents', 'worktrees', 'composer_drafts',
    'import_runs']
  LOOP
    EXECUTE format('CREATE TRIGGER server_migration_fence BEFORE INSERT ON %I FOR EACH ROW
      EXECUTE FUNCTION server_migration_fence()', fenced);
  END LOOP;
END
$$;

-- Every public table that holds at least one row, except the given ones. Deny by default: a table added
-- later counts as data until the migration classifies it.
CREATE FUNCTION server_migration_occupied(allowed text[]) RETURNS SETOF text LANGUAGE plpgsql STABLE AS $$
DECLARE
  name text;
  found boolean;
BEGIN
  FOR name IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.relname <> ALL (allowed)
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', name) INTO found;

    IF found THEN
      RETURN NEXT name;
    END IF;
  END LOOP;
END
$$;
