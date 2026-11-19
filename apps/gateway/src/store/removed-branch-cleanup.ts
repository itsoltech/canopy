import type { CommandResult } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { lockArchivedBranchUsers, lockBranchAdmission } from "./archived-branch.ts";
import { lockedOwnerModule } from "./module-access.ts";
import type { WorktreeRow } from "./worktrees.ts";

export interface RemovedBranchRow extends WorktreeRow {
  branch_cleanup_source: Uint8Array;
  removal_token: string | null;
}

const pastArchiveGrace = (sql: SqlClient.SqlClient) =>
  sql`EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id=w.id AND t.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id=w.id AND t.deleted_at IS NULL
      AND (t.archived_at IS NULL OR t.archived_at > now() - interval '24 hours'))`;

export function removedBranchCandidates(owner: string, project: string, worker: string) {
  return Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<RemovedBranchRow>`
    SELECT w.* FROM worktrees w WHERE w.owner_user_id=${owner}::uuid AND w.branch_cleanup_source IS NOT NULL
      AND (${project}='' OR w.project_id=nullif(${project},'')::uuid)
      AND (${worker}='' OR w.worker_id=nullif(${worker},'')::uuid)
      AND (w.removal_token IS NOT NULL OR (${pastArchiveGrace(sql)}))
    ORDER BY w.id`,
  );
}

/** Commit the attempt id before delivery so a disconnect can be reconciled with the worker journal. */
export function reserveRemovedBranch(row: RemovedBranchRow, attempt: string) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // A continuation holds this row while preparing its checkout, then admits a new thread on the worker.
        const available = yield* sql`SELECT id FROM worktrees WHERE id=${row.id}::uuid
          AND owner_user_id=${row.owner_user_id}::uuid AND branch_cleanup_source IS NOT NULL
          AND removal_token IS NULL FOR UPDATE SKIP LOCKED`;

        if (!available.length || !(yield* lockBranchAdmission(sql, row.worker_id))) return [];

        return yield* sql`UPDATE worktrees w SET removal_token=${attempt}::uuid, removal_started_at=now()
          WHERE w.id=${row.id}::uuid AND (${pastArchiveGrace(sql)}) RETURNING w.id`;
      }),
    ),
  );
}

/** Recheck the archived users under the committed reservation and hold module admission through the ACK. */
export function lockRemovedBranch(row: RemovedBranchRow, attempt: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!(yield* lockedOwnerModule(sql, row.owner_user_id, "threads"))) return false;

    if (!(yield* lockArchivedBranchUsers(sql, row))) return false;

    const rows = yield* sql`SELECT w.id FROM worktrees w WHERE w.id=${row.id}::uuid
      AND w.owner_user_id=${row.owner_user_id}::uuid AND w.removal_token=${attempt}::uuid
      AND w.branch_cleanup_source IS NOT NULL AND w.branch=${row.branch} AND w.detached_commit=''
      AND (${pastArchiveGrace(sql)})`;

    return rows.length > 0;
  });
}

/** A retryable result releases the attempt but keeps the worker-confirmed removal for another pass. */
export function finishRemovedBranch(row: RemovedBranchRow, attempt: string, result?: CommandResult) {
  const deleted = result?.ok && result.worktreeBranchDeleted;
  const finished = deleted || Boolean(result?.ok && result.worktreeBranchCleanupFinished);

  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE worktrees SET removal_token=NULL, removal_started_at=NULL,
      branch_cleanup_source=CASE WHEN ${finished} THEN NULL ELSE branch_cleanup_source END
      WHERE id=${row.id}::uuid AND owner_user_id=${row.owner_user_id}::uuid AND branch_cleanup_source IS NOT NULL
        AND removal_token=${attempt}::uuid RETURNING id`;

        if (deleted && rows.length)
          yield* sql`INSERT INTO audit_log (id,actor_user_id,action,target_type,target_id,details)
        VALUES (${Bun.randomUUIDv7()}::uuid,${row.owner_user_id}::uuid,'worktree.branch_deleted','worktree',${row.id}::uuid,
          ${JSON.stringify({ commandId: attempt, branch: row.branch })}::jsonb)`;
      }),
    ),
  );
}
