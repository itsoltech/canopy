import type { Command, CommandSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { Invalid, NotFound } from "./store.ts";
import { closeCheckWatches } from "./pr-check-notes.ts";

export type Dispatch<E = SqlError.SqlError | Invalid | NotFound> = (input: {
  workerId: string;
  threadId: string;
  turnId?: string;
  command: MessageInitShape<typeof CommandSchema>;
  ttlSeconds: number;
}) => Effect.Effect<Command, E>;

/** Called with lifecycle's thread locks held; cleanup remains durable while its worker is offline. */
export const stopThreadWorkerResources = <E>(
  sql: SqlClient.SqlClient,
  dispatch: Dispatch<E>,
  ids: string[],
  moduleDisabled = false,
) =>
  Effect.gen(function* () {
    const turns = yield* sql<{ id: string; thread_id: string; worker_id: string | null }>`
      SELECT u.id, u.thread_id, t.worker_id FROM turns u JOIN threads t ON t.id = u.thread_id
      WHERE t.id = ANY(${ids}::uuid[]) AND (u.status = 'running' OR
        (u.status = 'queued' AND EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id
          AND c.kind = 'startTurn' AND (c.status IN ('delivered', 'completed')
            OR (c.status = 'pending' AND (${!moduleDisabled} OR c.delivered_epoch IS DISTINCT FROM 0))))))
      ORDER BY u.thread_id, u.ordinal DESC`;

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
    // Superseded inputs must not replay after a later unarchive or restore.
    yield* sql`UPDATE worker_commands SET status = 'expired', completed_at = now(),
        result = CASE WHEN ${moduleDisabled} THEN jsonb_build_object('errorCode', 'MODULE_DISABLED', 'wasDispatched', status = 'delivered' OR delivered_epoch IS DISTINCT FROM 0) ELSE result END
        WHERE thread_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'delivered')
          AND kind IN ('createThread', 'startTurn', 'steerTurn', 'setGoal')`;

    const threads = yield* sql<{ id: string; worker_id: string }>`SELECT id, worker_id FROM threads
        WHERE id = ANY(${ids}::uuid[]) AND worker_id IS NOT NULL ORDER BY id`;

    for (const thread of threads)
      commands.push({
        workerId: thread.worker_id,
        command: yield* dispatch({
          workerId: thread.worker_id,
          threadId: thread.id,
          ttlSeconds: 86400,
          command: { kind: { case: "unloadThread", value: { threadId: thread.id } } },
        }),
      });

    return { commands, turns };
  });

export const stopThreadResources = (sql: SqlClient.SqlClient, dispatch: Dispatch, ids: string[]) =>
  Effect.gen(function* () {
    const { commands } = yield* stopThreadWorkerResources(sql, dispatch, ids);
    yield* sql`UPDATE thread_secrets SET status = 'expired', ciphertext = NULL, key_id = NULL,
        file_path = NULL, revision = revision + 1
        WHERE thread_id = ANY(${ids}::uuid[]) AND status IN ('pending', 'saved')`;
    yield* sql`UPDATE goals SET status = 'paused', resume_after_module_enable = FALSE, last_reason = 'thread closed', updated_at = now(),
        error = NULL, error_at = NULL WHERE thread_id = ANY(${ids}::uuid[]) AND (status = 'active' OR (status = 'paused' AND resume_after_module_enable))`;
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
    yield* closeCheckWatches(sql, ids);

    return commands;
  });
