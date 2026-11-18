import { GoalDirective } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../store/index.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

interface LegacyCleanup {
  thread_id: string;
  goal_id: string | null;
  tasks: string[];
  attempt: number;
  through: string;
}

/** Older workers accept UnloadThread but may leave native goals and background processes running.
 * Execute their existing stop controls under the durable unload intent, before new work may enter.
 */
export async function stopLegacyThreadWork(core: GatewayCore, connection: WorkerConnection, commandId: string) {
  if (connection.hello.capabilities.includes("thread_resource_cleanup_v1")) return;
  const runtime = core[coreState].options.runtime;

  const work = await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // A prefetched copy of a finished unload must not pause an already resumed goal.
          const target = (yield* sql<LegacyCleanup>`
        SELECT c.thread_id, t.last_seq::text AS through, coalesce((c.result->>'attempt')::integer,0) AS attempt,
          (SELECT g.id FROM goals g WHERE g.thread_id = t.id AND t.provider = 'codex'
            AND t.provider_thread_id IS NOT NULL AND (g.resume_after_module_enable OR
              (g.status = 'paused' AND g.native_status = 'active')) ORDER BY g.created_at DESC LIMIT 1) AS goal_id,
          ARRAY(SELECT i.content->'backgroundTask'->>'taskId' FROM thread_items i
            WHERE i.thread_id = t.id AND i.type = 'background_task' AND i.status = 'in_progress'
              AND i.content->'backgroundTask'->>'taskId' <> '') AS tasks
        FROM worker_commands c JOIN threads t ON t.id = c.thread_id WHERE c.id = ${commandId}::uuid
          AND c.worker_id = ${connection.workerId}::uuid AND c.kind = 'unloadThread'
          AND c.status IN ('pending','delivered') AND t.archived_at IS NULL AND t.deleted_at IS NULL
        FOR UPDATE OF c`)[0];

          if (!target) return;
          const { thread_id: threadId, goal_id: goalId, attempt } = target;
          const prefix = `${commandId}/${attempt}`;

          const thread = goalId
            ? yield* GatewayStore.use((s) => Effect.map(s.thread(threadId), s.threadSpec))
            : undefined;

          const replies = target.tasks.map((taskId) =>
            connection
              .sendCommand({ case: "stopTask", value: { threadId, taskId } }, 10_000, `${prefix}/stop/${taskId}`)
              .then(
                (r) => r.ok,
                () => undefined,
              ),
          );

          if (goalId && thread)
            replies.push(
              connection
                .sendCommand(
                  { case: "setGoal", value: { threadId, goalId, thread, directive: GoalDirective.PAUSE } },
                  10_000,
                  `${prefix}/pause/${goalId}`,
                )
                .then(
                  (r) => r.ok || /no (?:active )?goal|goal (?:does not exist|not found)/i.test(r.errorMessage),
                  () => undefined,
                ),
            );

          return { attempt, replies, through: target.through };
        }),
      ),
    ),
  );

  if (!work) return;
  const results = await Promise.all(work.replies);

  // Reuse the ID across a lost ACK. An explicit refusal can be cached by the worker, so retry it under a new ID.
  if (results.includes(false) && !results.includes(undefined)) {
    await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE worker_commands SET result=jsonb_build_object('attempt', ${work.attempt + 1}::int)
        WHERE id=${commandId}::uuid AND status IN ('pending','delivered')
          AND coalesce((result->>'attempt')::integer,0)=${work.attempt}`,
      ),
    );
  }

  // A legacy unload may have let the replayed journal advance during the ACK. In that case the caller
  // rereads the task list before admitting resumed work, reusing confirmed worker command IDs.
  return results.every(Boolean) ? work.through : false;
}
