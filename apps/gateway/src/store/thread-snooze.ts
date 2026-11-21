import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./errors.ts";
import type { ThreadRow } from "./rows.ts";
import { listThreadSelect } from "./thread-select.ts";

interface SnoozeTarget {
  origin: string;
  remote_parent_ref: string | null;
  archived_at: Date | null;
  moved_to: string | null;
}

export function threadSnoozeStore(sql: SqlClient.SqlClient) {
  return {
    setThreadSnooze: (owner: string, thread: string, snoozed: boolean, until: Date | null) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<SnoozeTarget>`SELECT origin, remote_parent_ref, archived_at, moved_to
            FROM threads WHERE id=${thread}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL FOR UPDATE`;

          if (!row) return yield* Effect.fail(new NotFound("thread not found"));

          if (row.archived_at) return yield* Effect.fail(new Invalid("This thread is archived."));

          if (row.moved_to) return yield* Effect.fail(new Invalid("This thread is moving to another computer."));

          if (row.origin === "agent" || row.remote_parent_ref)
            return yield* Effect.fail(new Invalid("Subagent threads inherit snooze from their parent."));

          // Check the database clock after acquiring the row lock so a delayed write cannot install a past deadline.
          if (until) {
            const [deadline] = yield* sql<{
              future: boolean;
            }>`SELECT ${until}::timestamptz > clock_timestamp() AS future`;

            if (!deadline?.future) return yield* Effect.fail(new Invalid("Choose a time in the future."));
          }

          const changed = yield* sql`UPDATE threads SET snoozed=${snoozed}, snoozed_until=${until}::timestamptz
            WHERE id=${thread}::uuid AND (snoozed, snoozed_until) IS DISTINCT FROM (${snoozed}::boolean, ${until}::timestamptz)
            RETURNING id`;

          return changed.length > 0;
        }),
      ),
    expireThreadSnoozes: (owner: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const changed = yield* sql<{ id: string }>`
            WITH due AS (
              SELECT id FROM threads WHERE owner_user_id=${owner}::uuid AND snoozed_until <= statement_timestamp()
                AND deleted_at IS NULL AND moved_to IS NULL
              ORDER BY snoozed_until,id LIMIT 64 FOR UPDATE SKIP LOCKED
            )
            UPDATE threads SET snoozed=false,snoozed_until=NULL FROM due WHERE threads.id=due.id RETURNING threads.id`;

          return changed.length
            ? yield* sql.unsafe<ThreadRow>(listThreadSelect("WHERE t.id=ANY($1::uuid[])"), [
                changed.map((row) => row.id),
              ])
            : [];
        }),
      ),
  };
}
