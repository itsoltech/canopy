-- Grok is a worker harness using ACP; instances use the same native/endpoint kinds.
ALTER TABLE agents DROP CONSTRAINT agents_provider_check;
ALTER TABLE agents ADD CONSTRAINT agents_provider_check CHECK (provider IN ('claude', 'codex', 'grok', 'anthropic', 'openai'));
ALTER TABLE agents DROP CONSTRAINT agents_kind_provider;
ALTER TABLE agents ADD CONSTRAINT agents_kind_provider CHECK ((kind = 'sdk' AND provider IN ('claude', 'codex', 'grok')) OR (kind = 'chat' AND provider IN ('anthropic', 'openai')));
ALTER TABLE threads DROP CONSTRAINT threads_provider_check;
ALTER TABLE threads ADD CONSTRAINT threads_provider_check CHECK (provider IN ('claude', 'codex', 'grok', 'anthropic', 'openai'));
ALTER TABLE threads DROP CONSTRAINT threads_runtime_placement;
ALTER TABLE threads ADD CONSTRAINT threads_runtime_placement CHECK (
  (runtime = 'worker' AND provider IN ('claude', 'codex', 'grok') AND worker_id IS NOT NULL AND workspace_id IS NOT NULL AND cwd IS NOT NULL)
  OR (runtime = 'gateway' AND provider IN ('anthropic', 'openai') AND worker_id IS NULL AND workspace_id IS NULL AND cwd IS NULL AND provider_profile_id IS NULL)
);
ALTER TABLE provider_instances DROP CONSTRAINT provider_instances_harness_check;
ALTER TABLE provider_instances ADD CONSTRAINT provider_instances_harness_check CHECK (harness IN ('claude', 'codex', 'grok'));
INSERT INTO provider_instances (harness, id, kind, built_in, all_workers) VALUES ('grok', 'native', 'native', true, true);
ALTER TABLE bots DROP CONSTRAINT bots_provider_check;
ALTER TABLE bots ADD CONSTRAINT bots_provider_check CHECK (provider IN ('claude', 'codex', 'grok'));
