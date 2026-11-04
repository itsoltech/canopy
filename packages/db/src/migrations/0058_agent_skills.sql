CREATE TABLE agent_skills (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id)
);
CREATE INDEX agent_skills_owner ON agent_skills(owner_user_id, created_at, id);

-- Immutable artifacts survive library deletion; no automatic upstream execution.
CREATE TABLE agent_skill_versions (
  skill_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, owner_user_id, version)
);

ALTER TABLE worker_environments ADD COLUMN skills_supported boolean NOT NULL DEFAULT false;
