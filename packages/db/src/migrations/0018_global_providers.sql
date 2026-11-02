-- Global provider instances (docs/worker-config.md, section 9). An instance is a harness (Claude Code, Codex) and an
-- id, defined once in the gateway and enabled on the workers the user chooses, with optional per-worker overrides.
-- What a worker runs is still its versioned configuration (worker_configs, history): the gateway writes the
-- effective instances (global ⊕ worker override) into worker_configs.config.profiles, one profile per instance.
-- Secrets stay in `secrets`; definitions and overrides hold {"secretRef": "<secrets.id>"}.

CREATE TABLE provider_instances (
  harness        text NOT NULL CHECK (harness IN ('claude', 'codex')),
  -- Stable: threads store it (threads.provider_profile_id, NULL = native) together with threads.provider.
  id             text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  label          text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  -- native = the harness's own login on the device; endpoint = Anthropic/OpenAI-compatible URL + key (CLIProxyAPI).
  kind           text NOT NULL CHECK (kind IN ('native', 'endpoint')),
  base_url       text NOT NULL DEFAULT '',
  api_key        jsonb,                                  -- {"secretRef": …}
  env            jsonb NOT NULL DEFAULT '[]',            -- [{name, value | {"secretRef": …}, secret}]
  runtime        jsonb NOT NULL DEFAULT '{}',            -- binaryPath, homePath, shadowHomePath, launchArgs, ownLogin
  accent_color   text NOT NULL DEFAULT '' CHECK (accent_color ~ '^(#[0-9a-f]{6})?$'),
  -- Pickers: favorites in the user's order; a model is shown when listed in shown_models, or when the provider does
  -- not hide it and it is not in hidden_models. custom_models are ids outside the catalog.
  favorites      text[] NOT NULL DEFAULT '{}',
  hidden_models  text[] NOT NULL DEFAULT '{}',
  shown_models   text[] NOT NULL DEFAULT '{}',
  custom_models  text[] NOT NULL DEFAULT '{}',
  -- Enabled on every worker (also ones registered later), unless a worker row says otherwise.
  all_workers    boolean NOT NULL DEFAULT false,
  built_in       boolean NOT NULL DEFAULT false,
  revision       bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (harness, id),
  CONSTRAINT provider_instances_built_in CHECK (NOT built_in OR (id = 'native' AND kind = 'native')),
  CONSTRAINT provider_instances_endpoint CHECK (kind = 'endpoint' OR (base_url = '' AND api_key IS NULL))
);

-- Per worker: enabled (NULL = follows all_workers) and overrides of OS- or network-specific fields
-- (binaryPath, homePath, shadowHomePath, launchArgs, env merged by name, baseUrl, apiKey).
CREATE TABLE provider_instance_workers (
  harness      text NOT NULL,
  instance_id  text NOT NULL,
  worker_id    uuid NOT NULL REFERENCES workers (id),
  enabled      boolean,
  overrides    jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (harness, instance_id, worker_id),
  FOREIGN KEY (harness, instance_id) REFERENCES provider_instances (harness, id) ON DELETE CASCADE
);
CREATE INDEX provider_instance_workers_worker ON provider_instance_workers (worker_id);

-- The built-in device login instances exist for both harnesses on every worker.
INSERT INTO provider_instances (harness, id, kind, built_in, all_workers) VALUES ('claude', 'native', 'native', true, true), ('codex', 'native', 'native', true, true);

-- Per-worker profiles (0015) become global instances, one per harness the profile served, with the same id, so
-- threads keep resolving. The first worker (by id) defines an instance; a later worker with different endpoint,
-- key or variables gets them as its overrides. A later worker whose profile of that id connects differently
-- (native vs endpoint) gets its own instance "<id>-<n>" and its threads are moved to it.
DO $$
DECLARE
  w record;
  p jsonb;
  h text;
  pid text;
  target text;
  pkind text;
  existing provider_instances%ROWTYPE;
  defined boolean;
  ovr jsonb;
  n int;
BEGIN
  FOR w IN SELECT worker_id, config FROM worker_configs ORDER BY worker_id LOOP
    FOR p IN SELECT value FROM jsonb_array_elements(coalesce(w.config -> 'profiles', '[]'::jsonb)) LOOP
      pid := p ->> 'id';
      CONTINUE WHEN pid IS NULL OR pid !~ '^[a-z0-9][a-z0-9_-]{0,62}$';
      pkind := CASE WHEN p ->> 'kind' = 'PROVIDER_PROFILE_KIND_CLIPROXYAPI' THEN 'endpoint' ELSE 'native' END;
      FOR h IN
        SELECT CASE x WHEN 'PROVIDER_CLAUDE' THEN 'claude' ELSE 'codex' END
          FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_array_length(coalesce(p -> 'providers', '[]'::jsonb)) = 0
                      THEN '["PROVIDER_CLAUDE", "PROVIDER_CODEX"]'::jsonb ELSE p -> 'providers' END) AS x
      LOOP
        target := pid;
        SELECT * INTO existing FROM provider_instances WHERE harness = h AND id = pid;
        defined := FOUND;
        IF defined AND existing.kind <> pkind THEN
          n := 2;
          WHILE EXISTS (SELECT 1 FROM provider_instances WHERE harness = h AND id = left(pid, 58) || '-' || n) LOOP n := n + 1; END LOOP;
          target := left(pid, 58) || '-' || n;
          UPDATE threads SET provider_profile_id = target WHERE worker_id = w.worker_id AND provider = h AND provider_profile_id = pid;
        END IF;
        IF target <> pid OR NOT defined THEN
          INSERT INTO provider_instances (harness, id, label, kind, base_url, api_key, env)
          VALUES (h, target, left(coalesce(p ->> 'displayName', ''), 80), pkind,
                  CASE WHEN pkind = 'endpoint' THEN coalesce(p ->> 'baseUrl', '') ELSE '' END,
                  CASE WHEN pkind = 'endpoint' AND jsonb_typeof(p -> 'apiKey') = 'object' THEN p -> 'apiKey' END,
                  coalesce(p -> 'env', '[]'::jsonb));
          ovr := '{}'::jsonb;
        ELSE
          -- Same id and kind on another worker (or the built-in native): differences become this worker's overrides.
          IF existing.label = '' AND coalesce(p ->> 'displayName', '') <> '' THEN
            UPDATE provider_instances SET label = left(p ->> 'displayName', 80) WHERE harness = h AND id = pid;
          END IF;
          ovr := '{}'::jsonb;
          IF pkind = 'endpoint' AND existing.base_url IS DISTINCT FROM coalesce(p ->> 'baseUrl', '') THEN
            ovr := ovr || jsonb_build_object('baseUrl', coalesce(p ->> 'baseUrl', ''));
          END IF;
          IF pkind = 'endpoint' AND jsonb_typeof(p -> 'apiKey') = 'object' AND existing.api_key IS DISTINCT FROM p -> 'apiKey' THEN
            ovr := ovr || jsonb_build_object('apiKey', p -> 'apiKey');
          END IF;
          IF existing.env IS DISTINCT FROM coalesce(p -> 'env', '[]'::jsonb) AND jsonb_array_length(coalesce(p -> 'env', '[]'::jsonb)) > 0 THEN
            ovr := ovr || jsonb_build_object('env', p -> 'env');
          END IF;
        END IF;
        INSERT INTO provider_instance_workers (harness, instance_id, worker_id, enabled, overrides)
        VALUES (h, target, w.worker_id, NOT coalesce((p ->> 'disabled')::boolean, false), ovr)
        ON CONFLICT (harness, instance_id, worker_id) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- Model choices per worker (0015) become the instance's: what the newest choice hid stays hidden, models the
-- provider hides but the user showed stay shown. "Hide new models" has no global counterpart (new ones show).
UPDATE provider_instances i
   SET hidden_models = s.hidden, shown_models = s.shown
  FROM (
    SELECT DISTINCT ON (provider, profile_id) provider, profile_id,
           ARRAY(SELECT unnest(known) EXCEPT SELECT unnest(shown) ORDER BY 1) AS hidden, shown
      FROM provider_model_selections
     ORDER BY provider, profile_id, updated_at DESC
  ) s
 WHERE i.harness = s.provider AND i.id = s.profile_id;

DROP TABLE provider_model_selections;

-- Favorite models were a user setting (UserSettings.model_favorites: provider, profile or "" = any, model); they
-- move to the instances, in the user's order.
DO $$
DECLARE
  f jsonb;
  h text;
BEGIN
  FOR f IN
    SELECT value FROM user_settings, jsonb_array_elements(coalesce(settings -> 'modelFavorites' -> 'models', '[]'::jsonb)) WITH ORDINALITY AS e(value, n)
     ORDER BY user_settings.updated_at, n
  LOOP
    h := CASE f ->> 'provider' WHEN 'PROVIDER_CLAUDE' THEN 'claude' WHEN 'PROVIDER_CODEX' THEN 'codex' END;
    CONTINUE WHEN h IS NULL OR coalesce(f ->> 'model', '') = '';
    UPDATE provider_instances
       SET favorites = favorites || (f ->> 'model')
     WHERE harness = h AND (coalesce(f ->> 'profileId', '') = '' OR id = f ->> 'profileId') AND NOT ((f ->> 'model') = ANY (favorites));
  END LOOP;
END $$;
