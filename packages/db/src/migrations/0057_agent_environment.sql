-- Desired state belongs to the owner. Reports belong to the authenticated worker.
CREATE TABLE agent_environments (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE instruction_documents (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instruction_documents_owner ON instruction_documents(owner_user_id, created_at, id);

-- A tombstone version preserves deletion history, without changing an applied version.
CREATE TABLE instruction_document_versions (
  document_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision)
);

CREATE TABLE worker_environments (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  automatic_tags text[] NOT NULL DEFAULT '{}',
  manual_tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(manual_tags) <= 32),
  supported boolean NOT NULL DEFAULT false,
  report jsonb NOT NULL DEFAULT '{}',
  resolutions jsonb NOT NULL DEFAULT '{}',
  reported_at timestamptz
);
