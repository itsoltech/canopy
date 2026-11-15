-- Desktop → server migration, stage 1 (docs/desktop-server-migration.md §5, §10): durable sessions on both
-- gateways, per-home invitations and their mutual-TLS session credentials, and the empty-target reservation.
-- No migrated data lives here. Secrets: the invitation is stored as a SHA-256 hash; the source's session private
-- key and the server's addresses only encrypted with that gateway's secrets key.
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
  -- The server's Network access origins (private addresses), AES-GCM with this gateway's secrets key.
  origins               bytea NOT NULL,
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

-- The empty-target reservation (§3). One row for the whole database: a server imports one group of homes.
-- Every fenced write holds a shared transaction lock (advisory key below) until it commits; reserving takes it
-- exclusively, so it waits for writers already in flight, and then checks emptiness in a new statement that
-- sees what they committed. A writer that starts later waits for the reservation and then reads it. Writers
-- outside READ COMMITTED also lock the row FOR SHARE: a snapshot older than the reservation then fails with
-- a serialization error instead of passing. An unpaired reservation lapses with its invitations.
CREATE TABLE server_migration_reservation (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  session_id uuid REFERENCES server_migration_sessions (id) ON DELETE SET NULL,
  expires_at timestamptz
);

INSERT INTO server_migration_reservation DEFAULT VALUES;

-- Never imported data: this server's identity and Network access, runtime clocks, limiters and diagnostics,
-- the operator's paired devices, its own audit and the migration's tables.
CREATE FUNCTION server_migration_runtime_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['schema_migrations', 'computer_identity', 'network_access', 'computer_pairing_budget',
    'computer_thread_clock', 'computer_thread_changes', 'config_clock', 'github_api_slots', 'github_api_budgets',
    'database_maintenance', 'diagnostics_state', 'diagnostics_rollups', 'mobile_devices', 'mobile_pairings',
    'bot_view_clock', 'composer_draft_clock', 'audit_log', 'server_migration_sessions', 'server_migration_sources',
    'server_migration_targets', 'server_migration_reservation']
$$;

-- Tables a new server fills itself. Only the exact rows it creates are bootstrap; any other row is data.
CREATE FUNCTION server_migration_bootstrap_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['users', 'projects', 'provider_instances', 'config_items']
$$;

-- Whether a row is exactly what the server creates at start: the scratch project, an untouched built-in native
-- profile and its untouched configuration record. Users are checked by owner (server_migration_occupied).
CREATE FUNCTION server_migration_default_row(tbl text, r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE tbl
    WHEN 'projects' THEN r->>'kind' = 'scratch' AND r->>'slug' = 'system-scratch' AND r->>'name' = 'No project'
      AND r->>'description' = '' AND r->'archived_at' = 'null' AND r->'config_deleted' = 'false'
    WHEN 'provider_instances' THEN r->>'id' = 'native' AND r->>'kind' = 'native' AND r->'built_in' = 'true'
      AND r->>'label' = '' AND r->>'base_url' = '' AND r->'api_key' = 'null' AND r->'env' = '[]'
      AND r->'runtime' = '{}' AND r->>'accent_color' = '' AND r->'favorites' = '[]' AND r->'hidden_models' = '[]'
      AND r->'shown_models' = '[]' AND r->'custom_models' = '[]' AND r->'all_workers' = 'true'
      AND r->'revision' = '1' AND r->'proxy_id' = 'null' AND r->'created_by' = 'null'
    WHEN 'config_items' THEN r->>'kind' = 'instance' AND r->>'local_id' = 'native'
      AND r->>'global_id' IN ('claude:native', 'codex:native', 'grok:native') AND r->>'home_node_id' = ''
      AND r->>'identity' = '' AND r->>'unsupported' = '' AND r->'deleted'->'value' = 'false'
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(r->'fields') f WHERE f.value->'edited' IS DISTINCT FROM 'false')
    ELSE false
  END
$$;

-- The reservation's lock: shared by writers, exclusive while reserving (server-migration/reservation.ts).
CREATE FUNCTION server_migration_lock_key() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('canopy.server_migration.reservation', 0)
$$;

CREATE FUNCTION server_migration_reserved() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  reservation record;
BEGIN
  -- Memory only: no row is written. Held until this writer commits.
  PERFORM pg_advisory_xact_lock_shared(server_migration_lock_key());

  IF current_setting('transaction_isolation') = 'read committed' THEN
    SELECT session_id, expires_at INTO reservation FROM server_migration_reservation WHERE singleton;
  ELSE
    SELECT session_id, expires_at INTO reservation FROM server_migration_reservation WHERE singleton FOR SHARE;
  END IF;

  RETURN reservation.session_id IS NOT NULL
    AND (reservation.expires_at IS NULL OR reservation.expires_at > clock_timestamp());
END
$$;

CREATE FUNCTION server_migration_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  -- The server's own start-up rows stay possible: default rows, and its owner re-asserted by email.
  IF TG_OP <> 'DELETE' AND server_migration_default_row(TG_TABLE_NAME, to_jsonb(NEW))
    AND (TG_OP = 'INSERT' OR server_migration_default_row(TG_TABLE_NAME, to_jsonb(OLD))) THEN
    RETURN NEW;
  END IF;

  -- The owner's start-up upsert by email: its INSERT conflicts, and its UPDATE leg changes nothing.
  IF TG_TABLE_NAME = 'users' AND TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM users u WHERE u.email = NEW.email) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF server_migration_reserved() THEN
    RAISE EXCEPTION 'Importing from desktop. Changes are paused.' USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- Which tables the fence must guard. Bootstrap tables: every insert, update and delete. Every other table is
-- empty on a reserved server, so updates and deletes change nothing; inserts are fenced on roots. A table
-- whose non-deferrable NOT NULL foreign key points to a fenced or covered table can't get a row either, so
-- hot child tables (events, items, commands) need no trigger. Later migrations that add tables call this
-- again; the schema test fails for a table that is neither runtime, fenced nor covered.
CREATE FUNCTION server_migration_fence_plan() RETURNS TABLE (name text, plan text) LANGUAGE plpgsql STABLE AS $$
DECLARE
  candidates text[];
  roots text[];
  covered text[] := '{}';
  added text[];
BEGIN
  SELECT coalesce(array_agg(c.relname::text), '{}') INTO candidates FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND c.relname <> ALL (server_migration_runtime_tables() || server_migration_bootstrap_tables());

  -- Roots: no qualifying foreign key to another candidate.
  SELECT coalesce(array_agg(t), '{}') INTO roots FROM unnest(candidates) t WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint k
    WHERE k.conrelid = t::regclass AND k.contype = 'f' AND NOT k.condeferrable
      AND k.confrelid::regclass::text <> t AND k.confrelid::regclass::text = ANY (candidates)
      AND NOT EXISTS (SELECT 1 FROM unnest(k.conkey) col JOIN pg_attribute a
        ON a.attrelid = k.conrelid AND a.attnum = col WHERE NOT a.attnotnull));

  LOOP
    SELECT coalesce(array_agg(t), '{}') INTO added FROM unnest(candidates) t
    WHERE t <> ALL (roots || covered) AND EXISTS (
      SELECT 1 FROM pg_constraint k
      WHERE k.conrelid = t::regclass AND k.contype = 'f' AND NOT k.condeferrable
        AND k.confrelid::regclass::text = ANY (roots || covered)
        AND NOT EXISTS (SELECT 1 FROM unnest(k.conkey) col JOIN pg_attribute a
          ON a.attrelid = k.conrelid AND a.attnum = col WHERE NOT a.attnotnull));
    EXIT WHEN cardinality(added) = 0;
    covered := covered || added;
  END LOOP;

  RETURN QUERY
    SELECT b, 'all' FROM unnest(server_migration_bootstrap_tables()) b
    UNION ALL SELECT t, 'insert' FROM unnest(candidates) t WHERE t <> ALL (covered)
    UNION ALL SELECT t, 'covered' FROM unnest(covered) t;
END
$$;

CREATE FUNCTION server_migration_install_fences() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM server_migration_fence_plan() WHERE plan <> 'covered' LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS server_migration_fence ON %I', item.name);
    EXECUTE format('CREATE TRIGGER server_migration_fence BEFORE %s ON %I FOR EACH ROW
      EXECUTE FUNCTION server_migration_fence()',
      CASE item.plan WHEN 'all' THEN 'INSERT OR UPDATE OR DELETE' ELSE 'INSERT' END, item.name);
  END LOOP;
END
$$;

SELECT server_migration_install_fences();

-- The tables that make this server non-empty for its owner, by name only. Deny by default: every table with
-- a row counts, except runtime tables and the exact bootstrap rows.
CREATE FUNCTION server_migration_occupied(owner uuid) RETURNS SETOF text LANGUAGE plpgsql STABLE AS $$
DECLARE
  name text;
  found boolean;
BEGIN
  FOR name IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.relname <> ALL (server_migration_runtime_tables())
    ORDER BY c.relname
  LOOP
    IF name = 'users' THEN
      found := EXISTS (SELECT 1 FROM users u WHERE u.id <> owner);
    ELSIF name = ANY (server_migration_bootstrap_tables()) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I x WHERE NOT server_migration_default_row(%L, to_jsonb(x))
        OR coalesce(to_jsonb(x)->>''owner_user_id'', $1::text) <> $1::text)', name, name)
        INTO found USING owner;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', name) INTO found;
    END IF;

    IF found THEN
      RETURN NEXT name;
    END IF;
  END LOOP;
END
$$;
