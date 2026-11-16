import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./store.ts";
import { configLock } from "../config-sync/persistence.ts";
import { mergeArchiveAllowed, mergeArchiveIdle } from "./thread-merge-archive.ts";
import { stopThreadResources, type Dispatch } from "./thread-cleanup.ts";

interface Owned {
  id: string;
  parent_thread_id: string | null;
  deleted_at: Date | null;
  deletion_batch_id: string | null;
  archived_at: Date | null;
  archived_by: string | null;
  moved_to: string | null;
  purged_at: Date | null;
}

const owned = (sql: SqlClient.SqlClient, userId: string, threadId: string, deleted = false) =>
  Effect.gen(function* () {
    const row =
      (yield* sql<Owned>`SELECT id, parent_thread_id, deleted_at, deletion_batch_id, archived_at, archived_by, moved_to, purged_at FROM threads
    WHERE id = ${threadId}::uuid AND owner_user_id = ${userId}::uuid FOR UPDATE`)[0];

    if (!row || (!deleted && row.deleted_at)) return yield* Effect.fail(new NotFound("thread not found"));

    if (row.purged_at) return yield* Effect.fail(new Invalid("this thread has been permanently deleted"));

    return row;
  });

/** All lifecycle transitions lock the same thread rows as the turn queue. Interrupts go into the durable
 * outbox before a thread is hidden, including an offline worker. Restoring never restarts work. */
export function threadLifecycle(sql: SqlClient.SqlClient, dispatch: Dispatch) {
  return {
    setThreadRead: (userId: string, threadId: string, unread: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(sql, userId, threadId);
          yield* sql`INSERT INTO thread_reads (user_id, thread_id, seen_seq, marked_unread)
        SELECT ${userId}::uuid, id, last_seq, ${unread} FROM threads WHERE id = ${threadId}::uuid
        ON CONFLICT (user_id, thread_id) DO UPDATE SET seen_seq = EXCLUDED.seen_seq, marked_unread = EXCLUDED.marked_unread, seen_at = now()`;
        }),
      ),
    setThreadArchived: (userId: string, threadId: string, archived: boolean, reason: "user" | "merge" = "user") =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (reason === "merge") yield* configLock(sql, userId);
          const row = yield* owned(sql, userId, threadId);

          if (reason === "merge" && !(yield* mergeArchiveAllowed(sql, userId, threadId)).length)
            return { ids: [], commands: [] };

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

          if (reason === "merge" && !(yield* mergeArchiveIdle(sql, ids))) return { ids: [], commands: [] };
          const commands = archived ? yield* stopThreadResources(sql, dispatch, ids) : [];
          yield* sql`UPDATE threads SET status = CASE WHEN ${archived} THEN 'archived'
          WHEN EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = threads.id AND u.status = 'running') THEN 'running'
          WHEN runtime = 'worker' AND provider_thread_id IS NULL THEN CASE WHEN status_detail IS NULL THEN 'creating' ELSE 'failed' END ELSE 'idle' END,
        archived_at = CASE WHEN ${archived} THEN coalesce(archived_at, now()) ELSE NULL END,
        auto_archive_on_merge = CASE WHEN ${!archived && row.archived_by === "merge"} THEN false ELSE auto_archive_on_merge END,
        archived_by = CASE WHEN ${archived} THEN CASE WHEN id = ${threadId}::uuid THEN ${reason} ELSE 'cascade' END ELSE NULL END,
        archived_by_thread_id = CASE WHEN ${archived} AND id <> ${threadId}::uuid THEN ${threadId}::uuid ELSE NULL END
        WHERE id = ANY(${ids}::uuid[])`;

          if (reason === "merge")
            yield* sql`INSERT INTO audit_log (id,actor_user_id,action,target_type,target_id,details)
              VALUES (${Bun.randomUUIDv7()}::uuid,${userId}::uuid,'thread.auto_archive_on_merge','thread',${threadId}::uuid,
                '{"source":"system","reason":"all linked pull requests merged"}'::jsonb)`;

          return { ids, commands };
        }),
      ),
    deleteThread: (userId: string, threadId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(sql, userId, threadId);

          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM threads WHERE (id = ${threadId}::uuid OR parent_thread_id = ${threadId}::uuid)
        AND owner_user_id = ${userId}::uuid AND deleted_at IS NULL ORDER BY id FOR UPDATE`;

          const ids = rows.map((r) => r.id);
          const commands = yield* stopThreadResources(sql, dispatch, ids);
          // Late deleted-thread events are acknowledged without projection, so finish its turns here.
          yield* sql`UPDATE turns SET status='interrupted', interrupt_source='system',
            interrupt_reason='thread deleted', completed_at=now()
            WHERE thread_id=ANY(${ids}::uuid[]) AND status='running'`;
          yield* sql`UPDATE threads SET deleted_at = now(), deletion_batch_id = ${threadId}::uuid, title_requested = false,
        title_revision = title_revision + 1 WHERE id = ANY(${ids}::uuid[])`;

          return { ids, commands };
        }),
      ),
    restoreThread: (userId: string, threadId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* owned(sql, userId, threadId, true);

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
        WHERE owner_user_id = ${userId}::uuid AND deleted_at IS NOT NULL AND moved_to IS NULL AND purged_at IS NULL AND
        (id = ${threadId}::uuid OR (deletion_batch_id = ${threadId}::uuid AND parent_thread_id = ${threadId}::uuid)) RETURNING id`;

          return rows.map((r) => r.id);
        }),
      ),
  };
}

export type ThreadLifecycle = ReturnType<typeof threadLifecycle>;
