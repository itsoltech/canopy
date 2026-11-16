import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** Shared by the durable sweep and the transaction that actually archives a thread. */
export const MERGE_ARCHIVE_SCOPE = `FROM threads t
  LEFT JOIN project_settings ps ON ps.project_id=t.project_id
  LEFT JOIN user_settings us ON us.user_id=t.owner_user_id
  WHERE t.owner_user_id=$1::uuid AND t.deleted_at IS NULL AND t.archived_at IS NULL
    AND t.moved_to IS NULL AND t.purged_at IS NULL
    AND coalesce(t.auto_archive_on_merge,
      (ps.settings->'threadDefaults'->>'autoArchiveOnMerge')::boolean,
      (us.settings->'threadDefaults'->>'autoArchiveOnMerge')::boolean, false)
    AND EXISTS (SELECT 1 FROM thread_pull_requests l WHERE l.owner_user_id=t.owner_user_id
      AND l.thread_id=t.id AND l.unlinked_at IS NULL)`;

/** Only complete, successful reads saved by prRemember count; a missing/revoked binding never does. */
export const ALL_LINKS_MERGED = `NOT EXISTS (
  SELECT 1 FROM thread_pull_requests l
  JOIN github_pull_requests p ON p.owner_user_id=l.owner_user_id AND p.id=l.pull_request_id
  LEFT JOIN github_repository_accounts r ON r.owner_user_id=p.owner_user_id AND r.repository_id=p.repository_id
  LEFT JOIN github_accounts a ON a.owner_user_id=r.owner_user_id AND a.id=r.account_id AND a.status='connected'
  WHERE l.owner_user_id=t.owner_user_id AND l.thread_id=t.id AND l.unlinked_at IS NULL
    AND (a.id IS NULL OR p.summary_account_id IS DISTINCT FROM a.id OR p.refresh_detail<>''
      OR p.summary->>'state' IS DISTINCT FROM 'merged'
      OR (a.auth_kind='device' AND NOT EXISTS (
        SELECT 1 FROM github_installation_repositories ir
        JOIN github_installations i USING (owner_user_id,account_id,installation_id)
        WHERE ir.owner_user_id=p.owner_user_id AND ir.account_id=a.id
          AND ir.repository_id=p.repository_id AND NOT i.suspended))))`;

export const mergeArchiveAllowed = (sql: SqlClient.SqlClient, owner: string, thread: string) =>
  sql.unsafe(`SELECT t.id ${MERGE_ARCHIVE_SCOPE} AND t.id=$2::uuid AND ${ALL_LINKS_MERGED}`, [owner, thread]);

/** Called with every affected thread locked, as admission and the turn queue lock those same rows. */
export const mergeArchiveIdle = (sql: SqlClient.SqlClient, ids: string[]) =>
  Effect.gen(function* () {
    const busy = yield* sql`SELECT t.id FROM threads t WHERE t.id=ANY(${ids}::uuid[]) AND (
      t.status NOT IN ('idle','failed') OR t.rewind_pending_id IS NOT NULL OR
      EXISTS (SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('running','queued')) OR
      EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.type='background_task' AND i.status='in_progress') OR
      EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id=t.id AND i.status='pending') OR
      EXISTS (SELECT 1 FROM goals g WHERE g.thread_id=t.id AND g.status IN ('active','proposed')) OR
      EXISTS (SELECT 1 FROM turn_steers s WHERE s.thread_id=t.id AND s.status IN ('pending','accepted')) OR
      EXISTS (SELECT 1 FROM background_task_notes n WHERE n.thread_id=t.id AND (n.status='steering' OR (n.status='waiting' AND n.wake))) OR
      EXISTS (SELECT 1 FROM agent_bus_calls c WHERE (c.source_thread_id=t.id OR c.target_thread_id=t.id) AND c.notify_status='pending'))`;

    return busy.length === 0;
  });
