-- Provider profiles the user manages (docs/worker-config.md, "Profile dostawców"). Profiles, their variables and
-- keys stay in worker_configs.config (versioned, history), secrets as {"secretRef": "<secrets.id>"}. Which catalog
-- models a profile shows in pickers is the gateway's own: it does not go to the worker and changes no version.

-- Per worker, profile and provider: the models shown in pickers. No row = every model of the catalog.
-- known = the catalog's models when the choice was saved; a model outside it is new and show_new decides.
CREATE TABLE provider_model_selections (
  worker_id   uuid NOT NULL REFERENCES workers (id),
  profile_id  text NOT NULL CHECK (profile_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  provider    text NOT NULL CHECK (provider IN ('claude', 'codex')),
  shown       text[] NOT NULL DEFAULT '{}',
  known       text[] NOT NULL DEFAULT '{}',
  show_new    boolean NOT NULL DEFAULT true,
  updated_by  uuid NOT NULL REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, profile_id, provider)
);
