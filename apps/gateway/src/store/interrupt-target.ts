import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { NotFound } from "./errors.ts";
import { DISPATCHED } from "./turn-select.ts";
import { WORKER_RESTARTED } from "./worker-oom-recovery.ts";

/** Same thread lock as finish ingestion and queue admission. The caller persists the interrupt before releasing it. */
export function interruptTarget(owner: string, threadId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const thread = (yield* sql<{ worker_id: string | null }>`SELECT worker_id FROM threads
      WHERE id = ${threadId}::uuid AND owner_user_id = ${owner}::uuid AND deleted_at IS NULL FOR UPDATE`)[0];

    if (!thread) return yield* Effect.fail(new NotFound("thread not found"));

    if (!thread.worker_id) return;

    // A Stop clicked before the UI learned of the OOM can arrive after Hello provisionally ended the turn,
    // after the journal queued its recovery, or after its start reached the worker.
    const turn = (yield* sql.unsafe<{ id: string; status: string; dispatched: boolean }>(
      `SELECT u.id, u.status, ${DISPATCHED} AS dispatched FROM turns u WHERE u.thread_id = $1::uuid AND
        (u.status = 'running' OR (u.status = 'queued' AND u.trigger = 'recovery') OR
         (u.status = 'interrupted' AND u.interrupt_source = 'system' AND u.interrupt_reason = $2 AND u.last_seq IS NULL
          AND u.trigger = 'user' AND NOT EXISTS (SELECT 1 FROM turns q WHERE q.thread_id = u.thread_id AND q.ordinal > u.ordinal)))
        ORDER BY (u.status = 'running') DESC, u.ordinal DESC LIMIT 1`,
      [threadId, WORKER_RESTARTED],
    ))[0];

    if (!turn) return;
    const cancelled = turn.status === "queued";

    if (cancelled) {
      yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE id = ${turn.id}::uuid`;
      yield* sql`UPDATE worker_commands SET status = 'expired', completed_at = now()
        WHERE turn_id = ${turn.id}::uuid AND kind = 'startTurn' AND status IN ('pending','delivered')`;
    }

    return { workerId: thread.worker_id, turnId: turn.id, cancelled, dispatch: !cancelled || turn.dispatched };
  });
}
