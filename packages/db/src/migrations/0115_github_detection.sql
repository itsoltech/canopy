CREATE TABLE github_detection_jobs (
  owner_user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  event_seq bigint NOT NULL DEFAULT 0,
  requested bigint NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  active_until timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  detail text NOT NULL DEFAULT '',
  cursors jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(owner_user_id,thread_id),
  FOREIGN KEY(owner_user_id,thread_id) REFERENCES threads(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX github_detection_due ON github_detection_jobs(owner_user_id,next_at);

CREATE TABLE github_git_contexts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  context jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,thread_id) REFERENCES threads(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX github_git_context_history ON github_git_contexts(owner_user_id,thread_id,id DESC);

ALTER TABLE thread_pull_requests ADD COLUMN head_repository_id text NOT NULL DEFAULT '';
ALTER TABLE thread_pull_requests ADD COLUMN head_ref text NOT NULL DEFAULT '';
ALTER TABLE thread_pull_requests ADD COLUMN head_oid text NOT NULL DEFAULT '';
ALTER TABLE thread_pull_requests ADD COLUMN context_id bigint REFERENCES github_git_contexts(id) ON DELETE SET NULL;
