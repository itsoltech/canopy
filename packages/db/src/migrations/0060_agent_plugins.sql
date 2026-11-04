ALTER TABLE worker_environments ADD COLUMN plugins_supported boolean NOT NULL DEFAULT false;

CREATE TABLE agent_marketplaces (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  marketplace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id)
);
CREATE TABLE agent_marketplace_previews (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  preview jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE agent_plugins (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  plugin jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, id)
);
CREATE TABLE agent_plugin_versions (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  plugin_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  plugin jsonb NOT NULL,
  PRIMARY KEY (owner_user_id, plugin_id, version)
);
CREATE INDEX agent_marketplaces_owner ON agent_marketplaces(owner_user_id);
CREATE INDEX agent_plugins_owner ON agent_plugins(owner_user_id);
CREATE INDEX agent_marketplace_previews_owner ON agent_marketplace_previews(owner_user_id, expires_at);
