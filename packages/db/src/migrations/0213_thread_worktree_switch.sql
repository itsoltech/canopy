-- The turn already running keeps its original directory until the harness admits another turn.
ALTER TABLE turns ADD COLUMN worktree_switch_source_cwd text;
CREATE INDEX turns_worktree_switch_source ON turns USING hash (worktree_switch_source_cwd)
  WHERE worktree_switch_source_cwd IS NOT NULL;

-- Cleanup still sees the harness using the old directory, including a task it started after the switch.
CREATE FUNCTION worktree_has_switched_turn(tree worktrees) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM turns u JOIN threads t ON t.id=u.thread_id
    WHERE t.worker_id=tree.worker_id AND u.worktree_switch_source_cwd=tree.path AND (
      u.status='running' OR EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.turn_id=u.id
        AND i.type='background_task' AND i.status='in_progress')))
$$;

CREATE OR REPLACE FUNCTION threads_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.rewind_pending_id IS NOT NULL AND (NEW.archived_at,NEW.deleted_at,NEW.moved_to)
      IS DISTINCT FROM (OLD.archived_at,OLD.deleted_at,OLD.moved_to) THEN
    RAISE EXCEPTION 'Wait for the thread to finish rewinding.' USING ERRCODE='check_violation';
  END IF;
  IF (NEW.project_id, NEW.owner_user_id, NEW.kind, NEW.parent_thread_id, NEW.root_thread_id, NEW.depth,
      NEW.runtime, NEW.provider, NEW.worker_id, NEW.workspace_id, NEW.fork_source_thread_id, NEW.fork_after_turn_id)
     IS DISTINCT FROM
     (OLD.project_id, OLD.owner_user_id, OLD.kind, OLD.parent_thread_id, OLD.root_thread_id, OLD.depth,
      OLD.runtime, OLD.provider, OLD.worker_id, OLD.workspace_id, OLD.fork_source_thread_id, OLD.fork_after_turn_id)
     OR (OLD.preparation_fingerprint IS NOT NULL AND NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id) THEN
    RAISE EXCEPTION 'thread placement and lineage are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.cwd, NEW.worktree_id, NEW.preparation_fingerprint)
     IS DISTINCT FROM (OLD.cwd, OLD.worktree_id, OLD.preparation_fingerprint)
     AND NOT (
       OLD.preparation_fingerprint IS NOT NULL AND NEW.preparation_fingerprint IS NULL
       AND OLD.status = 'creating' AND OLD.archived_at IS NULL AND OLD.deleted_at IS NULL AND OLD.moved_to IS NULL
       AND OLD.provider_thread_id IS NULL AND OLD.rewind_pending_id IS NULL
       AND NEW.cwd IS NOT NULL AND NEW.worktree_id IS NOT NULL
       AND NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND NEW.moved_to IS NULL
       AND NEW.provider_thread_id IS NULL AND NEW.rewind_pending_id IS NULL
     )
     AND NOT (
       OLD.preparation_fingerprint IS NULL AND NEW.preparation_fingerprint IS NULL
       AND OLD.runtime='worker' AND OLD.cwd IS NOT NULL AND NEW.cwd IS NOT NULL
       AND OLD.archived_at IS NULL AND OLD.deleted_at IS NULL AND OLD.moved_to IS NULL AND OLD.rewind_pending_id IS NULL
       AND NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND NEW.moved_to IS NULL AND NEW.rewind_pending_id IS NULL
       AND nullif(OLD.settings->'sandboxProfile','null'::jsonb) IS NULL
       AND ((NEW.worktree_id IS NOT NULL AND NEW.worktree_id IS DISTINCT FROM OLD.worktree_id) OR
            (NEW.worktree_id IS NULL AND NEW.cwd = (SELECT root_path FROM project_workspaces WHERE id=NEW.workspace_id)))
       AND EXISTS (SELECT 1 FROM turns WHERE id=nullif(current_setting('canopy.switch_worktree_turn',true),'')::uuid
                     AND thread_id=OLD.id AND status='running' AND rewind_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'thread worktree placement is immutable outside finalization or an active turn switch' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id
     AND (NEW.provider_thread_id IS NULL OR EXISTS (
       SELECT 1 FROM turns WHERE thread_id=NEW.id AND started_at IS NOT NULL
         AND rewind_id IS NULL AND provider_session_id=OLD.provider_thread_id))
     AND NOT EXISTS (
       SELECT 1 FROM thread_rewinds r WHERE r.id=OLD.rewind_pending_id AND r.thread_id=OLD.id
         AND r.owner_user_id=OLD.owner_user_id
         AND ((r.status='completed' AND OLD.provider_thread_id=r.source_provider_thread_id
                AND NEW.provider_thread_id=r.replacement_provider_thread_id)
           OR (r.status='restored' AND OLD.provider_thread_id=r.replacement_provider_thread_id
                AND NEW.provider_thread_id=r.source_provider_thread_id))) THEN
    RAISE EXCEPTION 'provider session replacement requires a completed rewind' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Both preparation and switching must take the same availability lock as removal.
DROP TRIGGER worktree_available_thread_finalization ON threads;
CREATE TRIGGER worktree_available_thread_update BEFORE UPDATE ON threads
  FOR EACH ROW WHEN (NEW.worktree_id IS DISTINCT FROM OLD.worktree_id)
  EXECUTE FUNCTION worktree_require_available();

-- Both preflight (before a worker creates a directory) and commit check the source under the caller lock.
CREATE FUNCTION lock_thread_worktree_source(
  p_owner uuid, p_worker uuid, p_thread uuid, p_turn uuid, p_source_cwd text, p_source_tree uuid
) RETURNS SETOF threads LANGUAGE plpgsql AS $$
DECLARE t threads%ROWTYPE;
BEGIN
  SELECT s.* INTO t FROM threads s
    JOIN projects p ON p.id=s.project_id AND p.owner_user_id=s.owner_user_id
    JOIN project_workspaces ws ON ws.id=s.workspace_id AND ws.project_id=p.id AND ws.worker_id=s.worker_id
    JOIN workers w ON w.id=s.worker_id AND (w.owner_user_id IS NULL OR w.owner_user_id=s.owner_user_id)
    WHERE s.id=p_thread AND s.owner_user_id=p_owner AND s.worker_id=p_worker AND s.runtime='worker'
      AND p.kind='project' AND p.archived_at IS NULL AND ws.archived_at IS NULL AND w.archived_at IS NULL AND w.revoked_at IS NULL
      AND s.archived_at IS NULL AND s.deleted_at IS NULL AND s.moved_to IS NULL
      AND s.preparation_fingerprint IS NULL AND s.rewind_pending_id IS NULL
      AND s.cwd=p_source_cwd AND s.worktree_id IS NOT DISTINCT FROM p_source_tree
      AND (s.worktree_id IS NULL OR EXISTS (
        SELECT 1 FROM worktrees old WHERE old.id=s.worktree_id AND old.removed_at IS NULL AND old.removal_token IS NULL))
    FOR SHARE OF p,ws FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM id FROM turns WHERE id=p_turn AND thread_id=t.id AND status='running' AND rewind_id IS NULL
    AND worktree_switch_source_cwd IS NULL FOR UPDATE;
  IF FOUND THEN RETURN NEXT t; END IF;
END $$;

-- The setting is private to this invocation (Postgres restores its previous value on return).
-- Scope the write to the authenticated source and derive the destination from its registered placement.
CREATE FUNCTION switch_thread_worktree(
  p_owner uuid, p_worker uuid, p_thread uuid, p_turn uuid,
  p_source_cwd text, p_source_tree uuid, p_destination uuid, p_workspace_root text
) RETURNS TABLE(cwd text, worktree_id uuid, branch text, detached_commit text)
LANGUAGE plpgsql SET canopy.switch_worktree_turn = '' AS $$
DECLARE
  t threads%ROWTYPE;
  dest worktrees%ROWTYPE;
BEGIN
  SELECT * INTO t FROM lock_thread_worktree_source(p_owner,p_worker,p_thread,p_turn,p_source_cwd,p_source_tree);
  IF NOT FOUND OR t.provider='grok' OR nullif(t.settings->'sandboxProfile','null'::jsonb) IS NOT NULL THEN RETURN; END IF;

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
  END IF;
  RETURN NEXT;
END $$;

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_tool_check;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_tool_check CHECK (tool IN (
  'list_agents', 'spawn_thread', 'send_message', 'wait_threads', 'get_thread', 'read_thread', 'list_threads',
  'interrupt_thread', 'close_thread', 'list_interactions', 'answer_interaction',
  'schedule_wakeup', 'schedule_recurring', 'list_schedules', 'cancel_schedule',
  'list_background_tasks', 'get_background_task', 'stop_background_task',
  'ask_user', 'get_answers', 'request_secret', 'show_images', 'import_image_reply', 'render_visual', 'render_html',
  'watch_pr_checks', 'list_pr_watches', 'cancel_pr_watch', 'link_pull_request', 'message_delegating_bot',
  'find_canopy_settings', 'list_project_secrets', 'switch_worktree'
)) NOT VALID;

ALTER TABLE agent_bus_calls DROP CONSTRAINT agent_bus_calls_starts_turn;
ALTER TABLE agent_bus_calls ADD CONSTRAINT agent_bus_calls_starts_turn CHECK (
  (CASE WHEN tool='switch_worktree' AND status='completed' AND arguments='{}' AND result IS NULL THEN true
    ELSE ((tool IN ('spawn_thread','send_message','ask_user') OR
        (tool='switch_worktree' AND arguments ? 'continuation')) AND status<>'failed') = (hops IS NOT NULL)
   END)
  AND (tool IN ('spawn_thread','send_message','ask_user') OR target_turn_id IS NULL)
) NOT VALID;
