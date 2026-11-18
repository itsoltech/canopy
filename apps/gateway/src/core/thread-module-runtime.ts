import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GoalRow, ThreadRow } from "../store/index.ts";
import { lockedOwnerModule, moduleDisabledMessage, ownerModule } from "../store/module-access.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { coreBroadcastGoal, resumeHarnessGoal } from "./core-goals.ts";
import type { GatewayCore } from "./core.ts";
import { redeliverWorkerCleanup } from "./worker-cleanup-delivery.ts";

/** Acquire before taking any thread/goal locks in a command admission transaction. */
export function requireThreadModule(core: GatewayCore) {
  const { actions, options } = core[coreState];

  return actions
    .run(Effect.flatMap(SqlClient.SqlClient, (sql) => lockedOwnerModule(sql, options.userId, "threads")))
    .then((enabled) => {
      if (!enabled) throw new InvalidError(moduleDisabledMessage("threads"));
    });
}

/** Small admission read for both idle threads and turns already in flight. */
export function queueAdmissionState(core: GatewayCore, threadId: string) {
  const { actions, options } = core[coreState];

  return actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ provider_thread_id: string | null; resume_goal: boolean }>`
      SELECT t.provider_thread_id, EXISTS (SELECT 1 FROM goals g WHERE g.thread_id = t.id
        AND g.status = 'paused' AND g.resume_after_module_enable) AS resume_goal
      FROM threads t WHERE t.id = ${threadId}::uuid AND t.owner_user_id = ${options.userId}::uuid
        AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.rewind_pending_id IS NULL
        AND ${ownerModule(sql, options.userId, "threads")}`.pipe(Effect.map((rows) => rows[0])),
    ),
  );
}

/** The claim and harness command commit together. Native cleanup must finish before resuming the evaluator. */
export async function resumeModuleGoal(core: GatewayCore, thread: ThreadRow) {
  const { actions } = core[coreState];
  await actions.transaction(async () => {
    const goal = await actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        if (!(yield* lockedOwnerModule(sql, thread.owner_user_id, "threads"))) return;
        yield* sql`SELECT id FROM threads WHERE id = ${thread.id}::uuid FOR UPDATE`;

        const resumed = (yield* sql<GoalRow>`UPDATE goals g SET status = 'active', resume_after_module_enable = FALSE,
        updated_at = now() FROM threads t WHERE t.id = ${thread.id}::uuid AND t.id = g.thread_id
        AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.rewind_pending_id IS NULL
        AND t.provider_thread_id IS NOT NULL AND g.status = 'paused' AND g.resume_after_module_enable
        AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id AND c.kind = 'unloadThread'
          AND c.status IN ('pending','delivered'))
        AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'running')
        RETURNING g.*`)[0];

        if (!resumed) return;

        const queued =
          thread.provider === "claude" &&
          (yield* sql`SELECT 1 FROM turns WHERE goal_id = ${resumed.id}::uuid
        AND trigger = 'goal' AND status = 'queued' LIMIT 1`).length > 0;

        return { resumed, queued };
      }),
    );

    if (!goal) return;

    if (!goal.queued) await resumeHarnessGoal(core, thread, goal.resumed);
    actions.defer(() => coreBroadcastGoal(core, thread.id));
  });
}

/** Also runs during startup recovery if the gateway stopped just after committing the setting. */
export async function pumpResumedThreads(core: GatewayCore) {
  const { actions, options } = core[coreState];

  const rows = await actions.run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ id: string }>`
    SELECT t.id FROM threads t WHERE t.owner_user_id = ${options.userId}::uuid
      AND ${ownerModule(sql, options.userId, "threads")}
      AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.rewind_pending_id IS NULL
      AND (EXISTS (SELECT 1 FROM goals g WHERE g.thread_id = t.id AND g.status = 'paused' AND g.resume_after_module_enable)
        OR EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued')
        OR (t.status = 'creating' AND t.provider_thread_id IS NULL AND EXISTS (SELECT 1 FROM worker_commands c
          WHERE c.thread_id = t.id AND c.kind = 'createThread' AND c.status = 'expired' AND c.result->>'errorCode' = 'MODULE_DISABLED')))
      AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'running')`,
    ),
  );

  for (const row of rows) await core.pump(row.id);
}

export async function reconcileThreadModule(core: GatewayCore, enabled: boolean) {
  await redeliverWorkerCleanup(core);

  if (enabled) await pumpResumedThreads(core);
}
