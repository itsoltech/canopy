-- CLI import (docs/import.md): runs, source threads and the mark of an imported thread.

-- Turns rebuilt from a CLI history.
ALTER TABLE turns DROP CONSTRAINT turns_trigger_check;
ALTER TABLE turns ADD CONSTRAINT turns_trigger_check CHECK (trigger IN ('user','agent_bus','schedule','interaction','goal','provider','recovery','background_task','bot','linked_agent','import'));
ALTER TABLE turns DROP CONSTRAINT turns_hops_by_trigger;
ALTER TABLE turns ADD CONSTRAINT turns_hops_by_trigger CHECK (
  (trigger IN ('user','goal','provider','recovery','import') AND hops = 0)
  OR (trigger IN ('agent_bus','background_task','bot','linked_agent') AND hops > 0)
  OR trigger IN ('schedule','interaction')
);

CREATE TABLE import_runs (
  id            uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users (id),
  worker_id     uuid NOT NULL REFERENCES workers (id),
  status        text NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled', 'undone')),
  mode          text NOT NULL CHECK (mode IN ('continue', 'history')),
  -- Selected threads that were imported before (no items were created for them).
  already_imported integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- One run per worker at a time.
CREATE UNIQUE INDEX import_runs_active ON import_runs (worker_id) WHERE status IN ('running', 'paused');
CREATE INDEX import_runs_owner ON import_runs (owner_user_id, created_at DESC);

CREATE TABLE import_items (
  id            uuid PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES import_runs (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  worker_id     uuid NOT NULL REFERENCES workers (id),
  position      integer NOT NULL,
  agent_cli     text NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'grok')),
  -- Stable source identity: the CLI root on the worker (ImportRoot.id) and the CLI's session id.
  root_id       text NOT NULL,
  native_id     text NOT NULL,
  source_key    text NOT NULL,
  title         text NOT NULL DEFAULT '',
  cwd           text NOT NULL DEFAULT '',
  -- ImportSnapshot of the scan: the import reads this prefix only.
  snapshot      jsonb NOT NULL,
  -- Project, workspace and directory of the thread; mode native | history.
  target        jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'importing', 'done', 'failed', 'cancelled', 'undone')),
  cursor        text NOT NULL DEFAULT '',
  thread_id     uuid REFERENCES threads (id),
  turns         integer NOT NULL DEFAULT 0,
  bytes_total   bigint NOT NULL DEFAULT 0,
  bytes_done    bigint NOT NULL DEFAULT 0,
  attempts      integer NOT NULL DEFAULT 0,
  error         text,
  warnings      jsonb NOT NULL DEFAULT '[]',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);

-- Importing again does not duplicate: one live source per owner and worker.
CREATE UNIQUE INDEX import_items_source ON import_items (owner_user_id, worker_id, root_id, agent_cli, native_id)
  WHERE status IN ('pending', 'importing', 'done', 'failed');
CREATE INDEX import_items_thread ON import_items (thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE thread_imports (
  thread_id     uuid PRIMARY KEY REFERENCES threads (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  item_id       uuid NOT NULL REFERENCES import_items (id),
  agent_cli     text NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'grok')),
  native_id     text NOT NULL,
  -- native: later turns resume a copy of the CLI session; history: read-only.
  mode          text NOT NULL CHECK (mode IN ('native', 'history')),
  source_cli_version text NOT NULL DEFAULT '',
  imported_at   timestamptz NOT NULL DEFAULT now()
);
