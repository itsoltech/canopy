ALTER TABLE agent_skill_versions ADD COLUMN source_commit text NOT NULL DEFAULT '';
CREATE TABLE agent_skill_source_previews (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  preview jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX agent_skill_source_previews_owner ON agent_skill_source_previews(owner_user_id, expires_at);
