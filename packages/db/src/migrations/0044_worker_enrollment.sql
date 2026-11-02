-- Bearer secrets are generated with 256 bits of entropy; only SHA-256 hashes persist.
CREATE TABLE worker_enrollments (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  worker_id uuid REFERENCES workers(id),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (worker_id IS NULL))
);
CREATE INDEX worker_enrollments_owner ON worker_enrollments(owner_user_id, created_at DESC);
