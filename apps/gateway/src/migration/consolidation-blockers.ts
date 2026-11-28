import type { SqlClient } from "effect/sql";

type Blocker = {
  kind: "thread" | "bot" | "schedule" | "worker" | "move" | "copy" | "connector" | "channel";
  id: string;
  reason: "active_work" | "worker_unavailable" | "leased" | "unfinished_move" | "commands_pending";
};

/** A source-side check for known execution state that requires drain or review. */
export function consolidationBlockers(sql: SqlClient.SqlClient, owner: string) {
  return sql<Blocker>`
    WITH live_threads AS (
      SELECT id,status,rewind_pending_id,runtime,worker_id,archived_at FROM threads
        WHERE owner_user_id=${owner}::uuid AND moved_to IS NULL AND deleted_at IS NULL
    ), live_bots AS (
      SELECT id,configuration->>'workerId' AS worker_id,archived_at FROM bots
        WHERE owner_user_id=${owner}::uuid AND moved_to IS NULL AND deleted_at IS NULL
    )
    SELECT 'move' AS kind,m.id,'unfinished_move' AS reason FROM computer_moves m
      WHERE m.owner_user_id=${owner}::uuid AND m.state IN ('preparing','prepared','committed','aborting')
    UNION ALL
    SELECT 'move',x.id,'unfinished_move' FROM thread_transfers x WHERE x.owner_user_id=${owner}::uuid
      AND (x.state IN ('preparing','prepared','committed') OR x.cleanup_pending)
    UNION ALL
    SELECT 'move',f.move_id,'unfinished_move' FROM computer_move_files f
      WHERE f.owner_user_id=${owner}::uuid AND f.state <> 'done'
    UNION ALL
    SELECT 'thread',t.id,'active_work' FROM live_threads t
      WHERE t.status IN ('creating','running','waiting_input') OR t.rewind_pending_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('queued','running'))
        OR EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id=t.id AND i.status='pending')
        OR EXISTS (SELECT 1 FROM turn_steers s WHERE s.thread_id=t.id AND s.status IN ('pending','accepted'))
        OR EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.type='background_task' AND i.status='in_progress')
        OR EXISTS (SELECT 1 FROM agent_bus_calls c WHERE (c.source_thread_id=t.id OR c.target_thread_id=t.id)
          AND (c.status='requested' OR c.notify_status IN ('pending','steering')))
    UNION ALL
    SELECT 'bot',b.id,'active_work' FROM live_bots b
      WHERE EXISTS (SELECT 1 FROM bot_turns t WHERE t.bot_id=b.id AND t.status IN ('queued','running','waiting'))
        OR EXISTS (SELECT 1 FROM bot_approvals a WHERE a.bot_id=b.id AND a.status='pending')
        OR EXISTS (SELECT 1 FROM bot_thread_watches w WHERE w.bot_id=b.id AND NOT w.delivered)
    UNION ALL
    SELECT 'thread',t.id,'worker_unavailable' FROM live_threads t
      WHERE t.runtime='worker' AND t.archived_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM workers w WHERE w.id=t.worker_id AND (w.owner_user_id=${owner}::uuid OR w.owner_user_id IS NULL)
          AND w.revoked_at IS NULL AND w.archived_at IS NULL)
    UNION ALL
    SELECT 'bot',b.id,'worker_unavailable' FROM live_bots b
      WHERE nullif(b.worker_id,'') IS NOT NULL AND b.archived_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM workers w WHERE w.id::text=b.worker_id
          AND (w.owner_user_id=${owner}::uuid OR w.owner_user_id IS NULL) AND w.revoked_at IS NULL AND w.archived_at IS NULL)
    UNION ALL
    SELECT 'schedule',s.id,'leased' FROM schedules s JOIN projects p ON p.id=s.project_id
      WHERE p.owner_user_id=${owner}::uuid AND s.status='active' AND s.lease_until>now()
        AND (s.thread_id IS NULL OR EXISTS (SELECT 1 FROM live_threads t WHERE t.id=s.thread_id))
    UNION ALL
    SELECT 'thread',t.id,'commands_pending' FROM threads t WHERE t.owner_user_id=${owner}::uuid AND EXISTS (
      SELECT 1 FROM worker_commands c WHERE c.thread_id=t.id AND c.status IN ('pending','delivered')
        AND (c.expires_at>now() OR c.kind IN ('rewindThread','unloadThread')))
    UNION ALL
    SELECT 'worker',w.id,'commands_pending' FROM workers w WHERE w.owner_user_id=${owner}::uuid AND EXISTS (
      SELECT 1 FROM worker_commands c WHERE c.worker_id=w.id AND c.thread_id IS NULL
        AND c.status IN ('pending','delivered') AND c.expires_at>now())
    UNION ALL
    SELECT 'copy',j.id,'active_work' FROM workspace_copy_jobs j
      WHERE j.owner_user_id=${owner}::uuid AND j.status IN ('queued','copying','finishing','waiting')
    UNION ALL
    SELECT 'channel',o.id,'active_work' FROM messenger_outbound o
      JOIN messenger_accounts a ON a.id=o.account_id
      WHERE a.owner_user_id=${owner}::uuid AND o.status IN ('pending','sending')
    UNION ALL
    SELECT 'connector',c.id,'active_work' FROM connector_executions c
      WHERE c.owner_user_id=${owner}::uuid AND c.status='running'
    ORDER BY kind,id,reason`;
}
