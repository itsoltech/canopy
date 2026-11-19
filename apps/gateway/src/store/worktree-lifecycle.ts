import { lockedOwnerModule, moduleDisabledMessage } from "./module-access.ts";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound, one } from "./errors.ts";
import { lockArchivedBranchUsers, lockBranchAdmission } from "./archived-branch.ts";
import type { WorktreeRow } from "./worktrees.ts";

export interface WorktreeLifecycleRow extends WorktreeRow {
  last_activity_at: Date;
  all_deleted: boolean;
  all_archived: boolean;
  archive_grace_period: boolean;
  busy: boolean;
  removal_token: string | null;
  removal_command: Uint8Array | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared by preview and the locked reservation. Includes every thread sharing the worktree. */
const snapshot = `SELECT w.*,
  greatest(w.last_used_at, (SELECT max(greatest(t.created_at,
    (SELECT greatest(u.queued_at,coalesce(u.started_at,u.queued_at),coalesce(u.completed_at,u.queued_at))
      FROM turns u WHERE u.thread_id = t.id
      ORDER BY greatest(u.queued_at,coalesce(u.started_at,u.queued_at),coalesce(u.completed_at,u.queued_at)) DESC LIMIT 1)))
    FROM threads t WHERE t.worktree_id = w.id)) AS last_activity_at,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id) AND
    NOT EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL) AS all_deleted,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL) AND NOT EXISTS (
    SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL AND t.archived_at IS NULL) AS all_archived,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL
    AND t.archived_at > now() - interval '24 hours') AS archive_grace_period,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND (
    t.status = 'creating' AND t.deleted_at IS NULL OR
    EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status IN ('queued', 'running')) OR
    EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending') OR
    EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = t.id AND i.type = 'background_task' AND i.status = 'in_progress') OR
    EXISTS (SELECT 1 FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled')
      AND (t.archived_at IS NULL AND t.deleted_at IS NULL OR g.status IN ('active', 'proposed'))) OR
    EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id AND c.status IN ('pending', 'delivered')
      AND c.kind IN ('startTurn', 'createThread', 'setGoal') AND c.expires_at > now()))) AS busy
  FROM worktrees w`;

export function worktreeLifecycleStore(sql: SqlClient.SqlClient) {
  return {
    worktreeInventory: (owner: string, project = "", worker = "", id = "") =>
      Effect.gen(function* () {
        if ([project, worker, id].some((value) => value && !UUID.test(value)))
          return yield* Effect.fail(new NotFound("worktree not found"));

        const rows = yield* sql.unsafe<WorktreeLifecycleRow>(
          `${snapshot}
          WHERE w.owner_user_id = $1::uuid AND (w.removed_at IS NULL OR $4 <> '')
            AND ($2 = '' OR w.project_id = nullif($2, '')::uuid)
            AND ($3 = '' OR w.worker_id = nullif($3, '')::uuid)
            AND ($4 = '' OR w.id = nullif($4, '')::uuid) ORDER BY w.last_used_at DESC`,
          [owner, project, worker, id],
        );

        if (id && !rows.length) return yield* Effect.fail(new NotFound("worktree not found"));

        return rows;
      }),

    reserveWorktreeRemoval: (
      owner: string,
      row: WorktreeLifecycleRow,
      command: MessageInitShape<typeof CommandSchema>,
      policyMatches?: (state: WorktreeLifecycleRow) => boolean,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "threads")))
            return yield* Effect.fail(new Invalid(moduleDisabledMessage("threads")));
          const id = row.id;
          const message = create(CommandSchema, command);

          if (message.kind.case !== "removeWorktree") return yield* Effect.fail(new Invalid("Invalid removal command"));
          const removal = message.kind.value;

          // Queue/lifecycle writers take thread locks first, then the availability trigger locks the worktree.
          yield* sql`SELECT id FROM threads WHERE worktree_id = ${id}::uuid ORDER BY id FOR UPDATE`;

          const tree = yield* one(
            yield* sql<WorktreeLifecycleRow>`SELECT * FROM worktrees
          WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND removed_at IS NULL FOR UPDATE`,
            "worktree",
          );

          if (tree.removal_token) return yield* Effect.fail(new Invalid("worktree cleanup already in progress"));

          if (tree.external) return yield* Effect.fail(new Invalid("external worktrees cannot be removed"));

          const state = yield* one(
            yield* sql.unsafe<WorktreeLifecycleRow>(`${snapshot} WHERE w.id = $1::uuid`, [id]),
            "worktree",
          );

          if (state.busy) return yield* Effect.fail(new Invalid("a thread is still using this worktree"));

          if (policyMatches && !policyMatches(state))
            return yield* Effect.fail(new Invalid("The cleanup policy no longer matches"));

          if (tree.detached_commit || tree.branch !== removal.target?.branch) {
            removal.deleteArchivedBranch = false;
            removal.trackBranchForCleanup = false;
          }

          if (removal.deleteArchivedBranch) {
            removal.deleteArchivedBranch =
              (yield* lockBranchAdmission(sql, tree.worker_id)) && (yield* lockArchivedBranchUsers(sql, tree));
          }

          const bytes = toBinary(CommandSchema, message);
          yield* sql`UPDATE worktrees SET removal_token = ${message.commandId}::uuid,
          branch_cleanup_authorized = ${removal.deleteArchivedBranch}, removal_started_at = now(), removal_command = ${bytes} WHERE id = ${id}::uuid`;

          return { ...state, removal_command: bytes, removal_token: message.commandId };
        }),
      ),

    lockRemovalBranch: (row: WorktreeLifecycleRow, token: string) =>
      Effect.gen(function* () {
        if (!(yield* lockedOwnerModule(sql, row.owner_user_id, "threads")))
          return yield* Effect.fail(new Invalid(moduleDisabledMessage("threads")));

        if (!(yield* lockArchivedBranchUsers(sql, row))) return false;

        const trees =
          yield* sql`SELECT id FROM worktrees WHERE id=${row.id}::uuid AND owner_user_id=${row.owner_user_id}::uuid
          AND removed_at IS NULL AND removal_token=${token}::uuid
          AND branch_cleanup_authorized AND NOT external AND branch=${row.branch} AND detached_commit=''`;

        return trees.length !== 0;
      }),

    finishWorktreeRemoval: (
      owner: string,
      id: string,
      token: string,
      branchDeleted: boolean,
      cleanupCandidate = false,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE worktrees SET removed_at = now(), removal_token = NULL,
          branch_cleanup_authorized = false, branch_cleanup_source = CASE WHEN ${cleanupCandidate} THEN removal_command END, removal_command = NULL,
          removal_started_at = NULL WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid
          AND removal_token = ${token}::uuid AND removed_at IS NULL RETURNING id`;

          if (!rows.length) return [];
          yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, 'worktree.removed', 'worktree', ${id}::uuid,
            ${JSON.stringify({ commandId: token, branchDeleted })}::jsonb)`;
          const threads = yield* sql<{ id: string }>`SELECT id FROM threads WHERE worktree_id = ${id}::uuid`;

          return threads.map((t) => t.id);
        }),
      ),

    cancelWorktreeRemoval: (owner: string, id: string, token: string) =>
      sql`UPDATE worktrees SET removal_token = NULL, removal_command = NULL, removal_started_at = NULL, branch_cleanup_authorized = false
        WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND removal_token = ${token}::uuid`.pipe(
        Effect.asVoid,
      ),
  };
}
