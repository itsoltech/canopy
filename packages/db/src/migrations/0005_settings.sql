-- User and project settings (docs/ui-api.md): the gateway keeps them, the browser is only a client.
-- settings = the protobuf JSON of the sections (ui.v1 AppearanceSettings, ThreadDefaults);
-- version grows with every write (optimistic concurrency between devices).

CREATE TABLE user_settings (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  settings    jsonb NOT NULL DEFAULT '{}',
  version     bigint NOT NULL CHECK (version > 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_settings (
  project_id  uuid PRIMARY KEY REFERENCES projects (id),
  settings    jsonb NOT NULL DEFAULT '{}',
  version     bigint NOT NULL CHECK (version > 0),
  updated_by  uuid NOT NULL REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
