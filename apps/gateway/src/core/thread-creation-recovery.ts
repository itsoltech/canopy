import { lockedOwnerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";
import { coreStartThread } from "./core-threads.ts";
import type { GatewayCore } from "./core.ts";

/** An archive may cancel the original CreateThread before the worker ever sees it.
 * Only new user work recreates that session; unarchive and cleanup ACK alone do nothing. */
export async function recoverThreadCreation(core: GatewayCore, threadId: string): Promise<void> {
  await core[coreState].actions.transaction(async () => {
    const ready = await core[coreState].actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        if (!(yield* lockedOwnerModule(sql, core[coreState].options.userId, "threads"))) return [];
        yield* sql`SELECT id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

        return yield* sql`UPDATE threads t SET status = 'creating', status_detail = NULL
        WHERE t.id = ${threadId}::uuid AND t.runtime = 'worker' AND t.provider_thread_id IS NULL
          AND t.owner_user_id=${core[coreState].options.userId}::uuid
          AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.rewind_pending_id IS NULL
          AND (EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued'
            AND u.author_user_id IS NOT NULL AND u.trigger IN ('user', 'goal'))
            OR (t.status = 'creating' AND EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id
              AND c.kind = 'createThread' AND c.status = 'expired' AND c.result->>'errorCode' = 'MODULE_DISABLED')))
          AND EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id
            AND c.kind = 'createThread' AND c.status = 'expired')
          AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id
            AND c.kind IN ('createThread', 'unloadThread') AND c.status IN ('pending', 'delivered'))
        RETURNING t.id`;
      }),
    );

    if (!ready.length) return;
    // Reuse the pinned fork point, current settings and scratch/worktree placement from the stored thread.
    await coreStartThread(core, await coreRun(core, (s) => s.thread(threadId)));
  });
}
