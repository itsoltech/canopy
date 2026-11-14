-- Harness rate limits through a proxy or an endpoint key belong to an unknown upstream account, not the user's plan.
DELETE FROM provider_usage u
USING provider_instances i
WHERE i.id = u.profile_id
  AND i.harness = CASE u.provider WHEN 1 THEN 'claude' WHEN 2 THEN 'codex' ELSE 'grok' END
  AND (
    i.kind <> 'native'
    OR i.proxy_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM provider_instance_workers a
      WHERE a.harness = i.harness AND a.instance_id = i.id AND a.worker_id = u.worker_id AND a.proxy_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE jsonb_typeof(i.env) WHEN 'array' THEN i.env ELSE '[]' END) e
      WHERE e->>'name' IN ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY',
        'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_BASE_URL', 'CLIPROXY_API_KEY')
    )
  );
