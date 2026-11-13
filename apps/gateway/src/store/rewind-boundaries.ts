import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "./errors.ts";

/** Rewind and Undo share the admission lock and must not cross newly started automation. */
export const rewindBoundaries = (sql: SqlClient.SqlClient, threadId: string, queuedAt: Date, ordinal: number) =>
  Effect.gen(function* () {
    const unsafe = yield* sql`SELECT id FROM turns WHERE thread_id=${threadId}::uuid AND ordinal>=${ordinal}
        AND rewind_id IS NULL AND (goal_id IS NOT NULL OR schedule_id IS NOT NULL)
      UNION ALL SELECT id FROM goals WHERE thread_id=${threadId}::uuid
        AND (status NOT IN ('achieved','cancelled') OR updated_at>=${queuedAt})
      UNION ALL SELECT id FROM schedules WHERE thread_id=${threadId}::uuid
        AND (status IN ('active','paused') OR created_at>=${queuedAt})`;

    if (unsafe.length)
      return yield* Effect.fail(new Invalid("Cannot edit across a goal or scheduled run. Fork this thread instead."));

    const children = yield* sql`SELECT id FROM threads WHERE parent_thread_id=${threadId}::uuid AND deleted_at IS NULL
      AND (status IN ('running','waiting','creating') OR EXISTS (SELECT 1 FROM turns u
        WHERE u.thread_id=threads.id AND u.status IN ('queued','running')) OR EXISTS (SELECT 1 FROM thread_items i
        WHERE i.thread_id=threads.id AND i.type='background_task' AND i.status='in_progress'))`;

    if (children.length) return yield* Effect.fail(new Invalid("Stop this thread's active subagents before editing."));
  });
