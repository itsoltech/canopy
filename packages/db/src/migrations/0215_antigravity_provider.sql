ALTER TABLE agents DROP CONSTRAINT agents_provider_check;
ALTER TABLE agents ADD CONSTRAINT agents_provider_check CHECK (provider IN ('claude', 'codex', 'grok', 'antigravity', 'anthropic', 'openai'));
ALTER TABLE agents DROP CONSTRAINT agents_kind_provider;
ALTER TABLE agents ADD CONSTRAINT agents_kind_provider CHECK ((kind = 'sdk' AND provider IN ('claude', 'codex', 'grok', 'antigravity')) OR (kind = 'chat' AND provider IN ('anthropic', 'openai')));
ALTER TABLE threads DROP CONSTRAINT threads_provider_check;
ALTER TABLE threads ADD CONSTRAINT threads_provider_check CHECK (provider IN ('claude', 'codex', 'grok', 'antigravity', 'anthropic', 'openai'));
ALTER TABLE threads DROP CONSTRAINT threads_runtime_placement;
ALTER TABLE threads ADD CONSTRAINT threads_runtime_placement CHECK (
  (runtime = 'worker' AND provider IN ('claude', 'codex', 'grok', 'antigravity') AND worker_id IS NOT NULL AND workspace_id IS NOT NULL
    AND (cwd IS NOT NULL OR preparation_fingerprint IS NOT NULL))
  OR (runtime = 'gateway' AND provider IN ('anthropic', 'openai') AND worker_id IS NULL AND workspace_id IS NULL AND cwd IS NULL AND provider_profile_id IS NULL)
);
ALTER TABLE provider_instances DROP CONSTRAINT provider_instances_harness_check;
ALTER TABLE provider_instances ADD CONSTRAINT provider_instances_harness_check CHECK (harness IN ('claude', 'codex', 'grok', 'antigravity'));
ALTER TABLE provider_instances ADD CONSTRAINT provider_instances_antigravity_native CHECK (
  harness <> 'antigravity' OR (kind = 'native' AND proxy_id IS NULL)
);
ALTER TABLE provider_instance_workers ADD CONSTRAINT provider_instance_workers_antigravity_native CHECK (
  harness <> 'antigravity' OR proxy_id IS NULL
);
INSERT INTO provider_instances (harness, id, kind, built_in, all_workers) VALUES ('antigravity', 'native', 'native', true, true);

-- Enable discovery on existing active configurations. Keep device login disabled on workers
-- configured exclusively for API keys and proxies, and leave all-disabled workers disabled.
WITH prior AS (
  SELECT worker_id, bool_or(coalesce(p->>'enabled','false')='true') AS enabled,
    bool_or(p->>'enabled'='true' AND coalesce(p->>'deviceLogin','') NOT IN ('DEVICE_LOGIN_NONE','2')) AS device_login
  FROM worker_configs, LATERAL (VALUES (config->'claude'),(config->'codex'),(config->'grok')) AS providers(p)
  WHERE NOT config ? 'antigravity' GROUP BY worker_id
)
UPDATE worker_configs c SET version=c.version+1, updated_at=now(),
  config=c.config || jsonb_build_object('version',(c.version+1)::text,'antigravity',
    jsonb_strip_nulls(jsonb_build_object('enabled',prior.enabled,'deviceLogin',
      CASE WHEN prior.enabled AND NOT coalesce(prior.device_login,false) THEN 'DEVICE_LOGIN_NONE' END)))
FROM prior WHERE c.worker_id=prior.worker_id;

-- Only harnesses that can resume in another working directory may commit the switch.
CREATE OR REPLACE FUNCTION switch_thread_worktree(
  p_owner uuid, p_worker uuid, p_thread uuid, p_turn uuid,
  p_source_cwd text, p_source_tree uuid, p_destination uuid, p_workspace_root text
) RETURNS TABLE(cwd text, worktree_id uuid, branch text, detached_commit text)
LANGUAGE plpgsql AS $$
DECLARE
  t threads%ROWTYPE;
  dest worktrees%ROWTYPE;
  previous_switch_turn text := current_setting('canopy.switch_worktree_turn',true);
BEGIN
  SELECT * INTO t FROM lock_thread_worktree_source(p_owner,p_worker,p_thread,p_turn,p_source_cwd,p_source_tree);
  IF NOT FOUND OR t.provider NOT IN ('claude','codex') OR nullif(t.settings->'sandboxProfile','null'::jsonb) IS NOT NULL THEN RETURN; END IF;

  -- lock_thread_worktree_source now holds the shared workspace lock. Compare the root the worker
  -- verified, including when selecting the primary checkout.
  IF NOT EXISTS (SELECT 1 FROM project_workspaces ws WHERE ws.id=t.workspace_id AND ws.root_path=p_workspace_root)
    THEN RETURN; END IF;

  worktree_id := p_destination;
  IF p_destination IS NOT NULL THEN
    SELECT * INTO dest FROM worktrees w WHERE w.id=p_destination AND w.owner_user_id=p_owner
      AND w.worker_id=p_worker AND w.workspace_id=t.workspace_id AND w.project_id=t.project_id
      AND w.removed_at IS NULL AND w.removal_token IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    cwd := dest.path; branch := dest.branch; detached_commit := dest.detached_commit;
  ELSE
    SELECT w.root_path,coalesce(h.branch,''),coalesce(h.detached_commit,'') INTO cwd,branch,detached_commit
      FROM project_workspaces w LEFT JOIN checkout_heads h ON h.workspace_id=w.id
      WHERE w.id=t.workspace_id AND w.project_id=t.project_id AND w.worker_id=p_worker FOR SHARE OF w;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  IF (t.cwd,t.worktree_id) IS DISTINCT FROM (cwd,p_destination) THEN
    PERFORM set_config('canopy.switch_worktree_turn',p_turn::text,true);
    UPDATE turns SET worktree_switch_source_cwd=t.cwd WHERE id=p_turn;
    UPDATE threads SET cwd=switch_thread_worktree.cwd, worktree_id=p_destination, settings=settings-'branchNote',
      pull_request_revision=pull_request_revision+1 WHERE id=t.id;

    -- Preserve historical PR associations. The previous checkout stops supplying current-branch evidence.
    INSERT INTO github_git_contexts(owner_user_id,thread_id,context) VALUES(p_owner,t.id,'{}');
    INSERT INTO github_detection_jobs(owner_user_id,thread_id,event_seq) VALUES(p_owner,t.id,t.last_seq)
      ON CONFLICT (owner_user_id,thread_id) DO UPDATE SET event_seq=excluded.event_seq,
        requested=github_detection_jobs.requested+1, next_at=now(), active_until=now()+interval '15 minutes',
        lease_id=NULL, lease_until=NULL, detail='', cursors='{}';
    PERFORM set_config('canopy.switch_worktree_turn',previous_switch_turn,true);
  END IF;
  RETURN NEXT;
END $$;
