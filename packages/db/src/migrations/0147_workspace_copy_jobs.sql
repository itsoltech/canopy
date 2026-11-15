-- Background workspace copies, kept by the client-facing gateway (docs/workspace-copy.md). The selection is stored
-- as SHA-256 path hashes only; no file names or contents.
CREATE TABLE workspace_copy_jobs (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  target_ref text NOT NULL,
  project_ref text NOT NULL,
  parent_path text NOT NULL,
  name text NOT NULL,
  target_name text NOT NULL DEFAULT '',
  ignored_hashes jsonb NOT NULL DEFAULT '[]',
  secret_hashes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'copying', 'finishing', 'waiting', 'completed', 'failed', 'cancelled')),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  total_bytes bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  files integer NOT NULL DEFAULT 0 CHECK (files >= 0),
  total_files integer NOT NULL DEFAULT 0 CHECK (total_files >= 0),
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  workspace_ref text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_copy_jobs_owner ON workspace_copy_jobs (owner_user_id, created_at DESC);
CREATE INDEX workspace_copy_jobs_open ON workspace_copy_jobs (owner_user_id)
  WHERE status IN ('queued', 'copying', 'finishing', 'waiting');
