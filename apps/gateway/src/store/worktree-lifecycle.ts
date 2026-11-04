import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound, one } from "./errors.ts";
import type { WorktreeRow } from "./worktrees.ts";

export interface WorktreeLifecycleRow extends WorktreeRow {
  last_activity_at: Date;
  all_deleted: boolean;
  all_settled: boolean;
  busy: boolean;
  removal_token: string | null;
  removal_command: Uint8Array | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared by preview and the locked reservation. Includes every thread sharing the worktree. */
const snapshot = `SELECT w.*,
  greatest(w.last_used_at, (SELECT max(greatest(t.created_at,
    (SELECT max(greatest(u.queued_at, u.started_at, u.completed_at)) FROM turns u WHERE u.thread_id = t.id)))
    FROM threads t WHERE t.worktree_id = w.id)) AS last_activity_at,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id) AND
    NOT EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL) AS all_deleted,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id) AND NOT EXISTS (
    SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL AND t.archived_at IS NULL
      AND (t.status <> 'idle' OR (SELECT u.status FROM turns u WHERE u.thread_id = t.id ORDER BY u.ordinal DESC LIMIT 1)
        IS DISTINCT FROM 'completed')) AS all_settled,
  EXISTS (SELECT 1 FROM threads t WHERE t.worktree_id = w.id AND (
    t.status = 'creating' AND t.deleted_at IS NULL OR
    EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status IN ('queued', 'running')) OR
    EXISTS (SELECT 1 FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending') OR
    EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = t.id AND i.type = 'background_task' AND i.status = 'in_progress') OR
    EXISTS (SELECT 1 FROM goals g WHERE g.thread_id = t.id AND g.status NOT IN ('achieved', 'cancelled')) OR
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

    reserveWorktreeRemoval: (owner: string, id: string, command: MessageInitShape<typeof CommandSchema>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Queue/lifecycle writers take thread locks first, then the availability trigger locks the worktree.
          yield* sql`SELECT id FROM threads WHERE worktree_id = ${id}::uuid ORDER BY id FOR UPDATE`;

          const tree = yield* one(
            yield* sql<WorktreeLifecycleRow>`SELECT * FROM worktrees
          WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND removed_at IS NULL FOR UPDATE`,
            "worktree",
          );

          if (tree.removal_token) return yield* Effect.fail(new Invalid("worktree cleanup already in progress"));

          const state = yield* one(
            yield* sql.unsafe<WorktreeLifecycleRow>(`${snapshot} WHERE w.id = $1::uuid`, [id]),
            "worktree",
          );

          if (state.busy) return yield* Effect.fail(new Invalid("a thread is still using this worktree"));
          const message = create(CommandSchema, command);
          yield* sql`UPDATE worktrees SET removal_token = ${message.commandId}::uuid,
          removal_started_at = now(), removal_command = ${toBinary(CommandSchema, message)} WHERE id = ${id}::uuid`;

          return state;
        }),
      ),

    finishWorktreeRemoval: (owner: string, id: string, token: string, branchDeleted: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE worktrees SET removed_at = now(), removal_token = NULL, removal_command = NULL,
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
      sql`UPDATE worktrees SET removal_token = NULL, removal_command = NULL, removal_started_at = NULL
        WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND removal_token = ${token}::uuid`.pipe(
        Effect.asVoid,
      ),
  };
}
