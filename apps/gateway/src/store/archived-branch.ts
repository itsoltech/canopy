import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { WorktreeRow } from "./worktrees.ts";

/** Briefly exclude admissions while publishing the durable fence. A busy worker can be retried on the next sweep. */
export const lockBranchAdmission = (sql: SqlClient.SqlClient, worker: string) =>
  sql<{
    locked: boolean;
  }>`SELECT pg_try_advisory_xact_lock(branch_cleanup_admission_key(${worker}::uuid)) AS locked`.pipe(
    Effect.map((rows) => rows[0]!.locked),
  );

/** Verify under the reservation lock or the committed admission fence in require_available_thread_branch. */
export function lockArchivedBranchUsers(sql: SqlClient.SqlClient, tree: WorktreeRow) {
  return sql<{ eligible: boolean }>`SELECT
      EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id=w.id AND t.archived_at IS NOT NULL AND t.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.worker_id=w.worker_id AND t.archived_at IS NULL
        AND t.deleted_at IS NULL AND worktree_branch_used_by(w,t)) AS eligible
    FROM worktrees w WHERE w.id=${tree.id}::uuid AND w.owner_user_id=${tree.owner_user_id}::uuid
      AND w.worker_id=${tree.worker_id}::uuid AND NOT w.external AND w.detached_commit='' AND w.branch=${tree.branch}`.pipe(
    Effect.map((rows) => rows[0]?.eligible ?? false),
  );
}
