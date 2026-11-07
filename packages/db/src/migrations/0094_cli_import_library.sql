-- CLI import, settings and library (docs/import.md, "Ustawienia i biblioteka"): what a run changed in Canopy,
-- with what was there before, so Undo can restore it when nobody changed it since.

CREATE TABLE import_library_items (
  id            uuid PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES import_runs (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  worker_id     uuid NOT NULL REFERENCES workers (id),
  position      integer NOT NULL,
  agent_cli     text NOT NULL CHECK (agent_cli IN ('claude', 'codex', 'grok')),
  -- Stable source identity: the CLI root on the worker, the kind and its name there (model, CLAUDE.md).
  root_id       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('setting', 'instruction', 'skill', 'command', 'marketplace')),
  name          text NOT NULL,
  -- sha256 of the value or content the scan saw; the worker refuses a changed file.
  digest        text NOT NULL,
  source_key    text NOT NULL,
  -- Value of a setting (a model id or a permission mode); never a secret.
  value         text NOT NULL DEFAULT '',
  label         text NOT NULL DEFAULT '',
  -- import | replace | keep_both
  action        text NOT NULL CHECK (action IN ('import', 'replace', 'keep_both')),
  -- kept: Undo left it, because it changed after the import.
  status        text NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'cancelled', 'undone', 'kept')),
  -- What the import changed: the setting with its previous value, or the library item and its revision.
  target        jsonb NOT NULL DEFAULT '{}',
  detail        text NOT NULL DEFAULT '',
  error         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);

-- The same item is imported once while it is live.
CREATE UNIQUE INDEX import_library_source ON import_library_items (owner_user_id, worker_id, root_id, agent_cli, kind, name, digest)
  WHERE status IN ('pending', 'done');
CREATE INDEX import_library_run ON import_library_items (run_id, position);
