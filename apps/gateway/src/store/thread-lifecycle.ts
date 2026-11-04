import type { Command, CommandSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { Invalid, NotFound } from "./store.ts";

type Fx<A> = Effect.Effect<A, SqlError.SqlError | Invalid | NotFound>;

type Dispatch = (input: {
  workerId: string;
  threadId: string;
  turnId: string;
  command: MessageInitShape<typeof CommandSchema>;
  ttlSeconds: number;
}) => Fx<Command>;

interface Owned {
  id: string;
  parent_thread_id: string | null;
  deleted_at: Date | null;
  deletion_batch_id: string | null;
  archived_at: Date | null;
  moved_to: string | null;
}

/** All lifecycle transitions lock the same thread rows as the turn queue. Interrupts go into the durable
 * outbox before a thread is hidden, including an offline worker. Restoring never restarts work. */
export function threadLifecycle(sql: SqlClient.SqlClient, dispatch: Dispatch) {
  const owned = (userId: string, threadId: string, deleted = false) =>
    Effect.gen(function* () {
      const row =
        (yield* sql<Owned>`SELECT id, parent_thread_id, deleted_at, deletion_batch_id, archived_at, moved_to FROM threads
      WHERE id = ${threadId}::uuid AND owner_user_id = ${userId}::uuid FOR UPDATE`)[0];

      if (!row || (!deleted && row.deleted_at)) return yield* Effect.fail(new NotFound("thread not found"));

      return row;
    });

  const stop = (ids: string[]) =>
    Effect.gen(function* () {
      const turns = yield* sql<{ id: string; thread_id: string; worker_id: string | null }>`
      SELECT u.id, u.thread_id, t.worker_id FROM turns u JOIN threads t ON t.id = u.thread_id
      WHERE t.id = ANY(${ids}::uuid[]) AND u.status = 'running'`;

      const commands: { workerId: string; command: Command }[] = [];

      for (const turn of turns)
        if (turn.worker_id)
          commands.push({
            workerId: turn.worker_id,
            command: yield* dispatch({
              workerId: turn.worker_id,
              threadId: turn.thread_id,
              turnId: turn.id,
              ttlSeconds: 86400,
              command: { kind: { case: "interruptTurn", value: { threadId: turn.thread_id, turnId: turn.id } } },
            }),
          });
      yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE thread_id = ANY(${ids}::uuid[]) AND status = 'queued'`;
      yield* sql`UPDATE turn_steers SET status = 'dropped', reason = 'thread closed', updated_at = now()
      WHERE thread_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'accepted')`;
      yield* sql`UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE thread_id = ANY(${ids}::uuid[]) AND status IN ('active', 'paused')`;
      yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled'
      WHERE (source_thread_id = ANY(${ids}::uuid[]) OR target_thread_id = ANY(${ids}::uuid[])) AND notify_status = 'pending'`;
      yield* sql`UPDATE interaction_requests SET status = 'expired', answered_at = now()
      WHERE thread_id = ANY(${ids}::uuid[]) AND status = 'pending'`;
      yield* sql`UPDATE interaction_requests SET answer_delivery = 'cancelled'
      WHERE thread_id = ANY(${ids}::uuid[]) AND answer_delivery IN ('pending', 'consumed')`;
      yield* sql`UPDATE background_task_notes SET status = 'cancelled', steer_id = NULL, reason = 'thread closed', updated_at = now()
      WHERE thread_id = ANY(${ids}::uuid[]) AND status IN ('waiting', 'steering')`;

      return commands;
    });

  return {
    setThreadRead: (userId: string, threadId: string, unread: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(userId, threadId);
          yield* sql`INSERT INTO thread_reads (user_id, thread_id, seen_seq, marked_unread)
        SELECT ${userId}::uuid, id, last_seq, ${unread} FROM threads WHERE id = ${threadId}::uuid
        ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = EXCLUDED.seen_seq, marked_unread = EXCLUDED.marked_unread, seen_at = now()`;
        }),
      ),
    setThreadArchived: (userId: string, threadId: string, archived: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(userId, threadId);

          if (Boolean(row.archived_at) === archived) return { ids: [threadId], commands: [] };

          if (
            !archived &&
            row.parent_thread_id &&
            (yield* sql`SELECT id FROM threads WHERE id = ${row.parent_thread_id}::uuid AND archived_at IS NOT NULL`)
              .length
          )
            return yield* Effect.fail(new Invalid("unarchive the parent thread first"));

          const children = row.parent_thread_id
            ? []
            : yield* sql<{ id: string }>`SELECT id FROM threads
        WHERE parent_thread_id = ${threadId}::uuid AND owner_user_id = ${userId}::uuid AND deleted_at IS NULL
          AND (CASE WHEN ${archived} THEN archived_at IS NULL
            ELSE archived_at IS NOT NULL AND archived_by = 'cascade' AND archived_by_thread_id = ${threadId}::uuid END)
        ORDER BY id FOR UPDATE`;

          const ids = [threadId, ...children.map((child) => child.id)];
          const commands = archived ? yield* stop(ids) : [];
          yield* sql`UPDATE threads SET status = CASE WHEN ${archived} THEN 'archived'
          WHEN EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = threads.id AND u.status = 'running') THEN 'running'
          WHEN runtime = 'worker' AND provider_thread_id IS NULL THEN CASE WHEN status_detail IS NULL THEN 'creating' ELSE 'failed' END ELSE 'idle' END,
        archived_at = CASE WHEN ${archived} THEN coalesce(archived_at, now()) ELSE NULL END,
        archived_by = CASE WHEN ${archived} THEN CASE WHEN id = ${threadId}::uuid THEN 'user' ELSE 'cascade' END ELSE NULL END,
        archived_by_thread_id = CASE WHEN ${archived} AND id <> ${threadId}::uuid THEN ${threadId}::uuid ELSE NULL END
        WHERE id = ANY(${ids}::uuid[])`;

          return { ids, commands };
        }),
      ),
    deleteThread: (userId: string, threadId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(userId, threadId);

          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM threads WHERE (id = ${threadId}::uuid OR parent_thread_id = ${threadId}::uuid)
        AND owner_user_id = ${userId}::uuid AND deleted_at IS NULL ORDER BY id FOR UPDATE`;

          const ids = rows.map((r) => r.id);
          const commands = yield* stop(ids);
          yield* sql`UPDATE threads SET deleted_at = now(), deletion_batch_id = ${threadId}::uuid, title_requested = false,
        title_revision = title_revision + 1 WHERE id = ANY(${ids}::uuid[])`;

          return { ids, commands };
        }),
      ),
    restoreThread: (userId: string, threadId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(userId, threadId, true);

          if (!row.deleted_at) return [threadId];

          // A thread that moved to a linked computer lives there now; restoring it here would make a second home.
          if (row.moved_to) return yield* Effect.fail(new Invalid("this thread moved to another computer"));

          if (
            row.parent_thread_id &&
            (yield* sql`SELECT id FROM threads WHERE id = ${row.parent_thread_id}::uuid AND deleted_at IS NOT NULL`)
              .length
          )
            return yield* Effect.fail(new Invalid("restore the parent thread first"));

          const rows = yield* sql<{ id: string }>`UPDATE threads SET deleted_at = NULL, deletion_batch_id = NULL,
        status = CASE WHEN archived_at IS NOT NULL THEN 'archived'
          WHEN EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = threads.id AND u.status = 'running') THEN 'running'
          WHEN runtime = 'worker' AND provider_thread_id IS NULL THEN CASE WHEN status_detail IS NULL THEN 'creating' ELSE 'failed' END ELSE 'idle' END
        WHERE owner_user_id = ${userId}::uuid AND deleted_at IS NOT NULL AND moved_to IS NULL AND
        (id = ${threadId}::uuid OR (deletion_batch_id = ${threadId}::uuid AND parent_thread_id = ${threadId}::uuid)) RETURNING id`;

          return rows.map((r) => r.id);
        }),
      ),
  };
}

export type ThreadLifecycle = ReturnType<typeof threadLifecycle>;
