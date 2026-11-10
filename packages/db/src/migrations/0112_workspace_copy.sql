CREATE TABLE workspace_copy_presets (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- SHA-256 path hashes only; no file names or contents.
  included jsonb NOT NULL DEFAULT '[]',
  excluded jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id)
);

CREATE TABLE workspace_copies (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  file_count integer NOT NULL CHECK (file_count >= 0),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  status text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'committed', 'completed', 'cancelled', 'failed')),
  directory text NOT NULL DEFAULT '',
  workspace_id uuid REFERENCES project_workspaces(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_copies_owner ON workspace_copies(owner_user_id, id);
