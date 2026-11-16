-- Cleanup intent survives its delivery TTL and must be acknowledged before thread content can be purged.
CREATE OR REPLACE FUNCTION thread_retention_ready(p_thread_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM threads c WHERE c.parent_thread_id=p_thread_id AND c.purged_at IS NULL)
    AND NOT EXISTS(WITH RECURSIVE dependents(id,purged_at) AS (
      SELECT f.id,f.purged_at FROM threads f WHERE f.fork_source_thread_id=p_thread_id
      UNION ALL SELECT f.id,f.purged_at FROM threads f JOIN dependents d ON f.fork_source_thread_id=d.id)
      SELECT 1 FROM dependents WHERE purged_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=p_thread_id AND u.status IN ('queued','running'))
    -- Delete already stops execution and discards late projections. A stale background item cannot
    -- permanently retain a closed thread after its recovery window has expired.
    AND NOT EXISTS(SELECT 1 FROM thread_items i JOIN threads t ON t.id=i.thread_id
      WHERE i.thread_id=p_thread_id AND i.type='background_task' AND i.status='in_progress'
        AND (t.deleted_at IS NULL OR t.deleted_at>now()-interval '31 days'))
    AND NOT EXISTS(SELECT 1 FROM worker_commands c WHERE c.thread_id=p_thread_id
      AND c.status IN ('pending','delivered') AND (c.expires_at>now() OR c.kind IN ('rewindThread','unloadThread')))
    AND NOT EXISTS(SELECT 1 FROM import_items i WHERE i.thread_id=p_thread_id AND i.status IN ('pending','importing'))
    AND NOT EXISTS(SELECT 1 FROM connector_executions c WHERE c.thread_id=p_thread_id AND c.status='running')
    AND NOT EXISTS(SELECT 1 FROM github_mutation_receipts r WHERE r.thread_id=p_thread_id AND r.state='in_flight')
    AND NOT EXISTS(SELECT 1 FROM computer_moves m JOIN threads t ON t.id=p_thread_id
      WHERE m.owner_user_id=t.owner_user_id AND m.kind='thread' AND m.item_id=p_thread_id
        AND m.state NOT IN ('done','aborted'))
    AND NOT EXISTS(SELECT 1 FROM thread_image_publications p WHERE p.thread_id=p_thread_id
      AND p.state='reserved' AND p.expires_at>now());
$$;
