-- Remote worker configuration (docs/worker-config.md).
-- A worker keeps locally only how to reach the gateway; everything else lives here and is pushed
-- to the worker as WorkerConfig on connect and on every change.

-- Secrets referenced by configurations (e.g. CLIProxyAPI keys). Encrypted by the gateway
-- (envelope encryption, key_id for rotation); plaintext never stored, never logged.
CREATE TABLE secrets (
  id             uuid PRIMARY KEY,
  owner_user_id  uuid REFERENCES users (id),             -- NULL = platform-wide (admin)
  name           text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  ciphertext     bytea NOT NULL,
  key_id         text NOT NULL,
  created_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz
);
CREATE UNIQUE INDEX secrets_owner_name ON secrets (owner_user_id, name) NULLS NOT DISTINCT;

-- Current configuration per worker. config is WorkerConfig as protobuf JSON with every secret
-- replaced by {"secretRef": "<secrets.id>"}; the gateway resolves references when sending.
CREATE TABLE worker_configs (
  worker_id        uuid PRIMARY KEY REFERENCES workers (id),
  version          bigint NOT NULL CHECK (version > 0),
  config           jsonb NOT NULL,
  updated_by       uuid NOT NULL REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Last ConfigApplied from the worker.
  applied_version  bigint,
  applied_ok       boolean,
  applied_at       timestamptz,
  apply_report     jsonb,                                -- issues, detected providers, profile availability
  CONSTRAINT worker_configs_applied_together CHECK (
    (applied_version IS NULL) = (applied_at IS NULL) AND (applied_at IS NULL) = (applied_ok IS NULL)
  ),
  CONSTRAINT worker_configs_applied_not_ahead CHECK (applied_version IS NULL OR applied_version <= version)
);

-- Which secrets a configuration references: blocks deleting a secret in use and finds the workers
-- to re-push after a rotation.
CREATE TABLE worker_config_secrets (
  worker_id  uuid NOT NULL REFERENCES worker_configs (worker_id) ON DELETE CASCADE,
  secret_id  uuid NOT NULL REFERENCES secrets (id),
  PRIMARY KEY (worker_id, secret_id)
);

-- Every version ever sent, for audit and rollback.
CREATE TABLE worker_config_history (
  worker_id   uuid NOT NULL REFERENCES workers (id),
  version     bigint NOT NULL,
  config      jsonb NOT NULL,
  updated_by  uuid NOT NULL REFERENCES users (id),
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (worker_id, version)
);

-- A changed configuration must carry a higher version (workers compare versions to skip resends).
CREATE FUNCTION worker_configs_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config AND NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'changed worker config must have a higher version (% -> %)', OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'worker config version cannot go back (% -> %)', OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER worker_configs_before_update BEFORE UPDATE ON worker_configs
  FOR EACH ROW EXECUTE FUNCTION worker_configs_before_update();

CREATE FUNCTION worker_configs_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.version <> OLD.version THEN
    INSERT INTO worker_config_history (worker_id, version, config, updated_by, updated_at)
    VALUES (NEW.worker_id, NEW.version, NEW.config, NEW.updated_by, NEW.updated_at);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER worker_configs_history AFTER INSERT OR UPDATE ON worker_configs
  FOR EACH ROW EXECUTE FUNCTION worker_configs_history();
