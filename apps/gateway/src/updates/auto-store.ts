import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";

/** How long the owner's turns must stay quiet before automatic updates start. */
export const AUTO_UPDATE_QUIET_MS = 5 * 60_000;

interface ActivityRow {
  enabled: boolean;
  busy: boolean;
}

/** The owner's opt-in and the work an update would interrupt. */
export class AutoUpdateStore {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  /**
   * Whether automatic updates may start: the owner opted in, no turn runs or waits and no background task runs on a
   * connected worker, no bot turn is pending, and no turn started or ended within the quiet period. Work on an offline
   * worker cannot run until it returns, so it does not hold updates back.
   */
  async due(online: readonly string[]): Promise<boolean> {
    const owner = this.owner;
    const quiet = `${AUTO_UPDATE_QUIET_MS / 1000} seconds`;

    const rows = await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // The recent-activity probe matches turns_last_activity: one index range per thread.
        return yield* sql<ActivityRow>`SELECT
          coalesce((SELECT (settings#>>'{appUpdates,autoUpdate}')::boolean FROM user_settings
            WHERE user_id = ${owner}::uuid), false) AS enabled,
          EXISTS (SELECT 1 FROM turns u JOIN threads t ON t.id = u.thread_id
            WHERE t.owner_user_id = ${owner}::uuid AND u.status IN ('queued', 'running')
              AND t.worker_id = ANY(${online}::uuid[]))
          OR EXISTS (SELECT 1 FROM thread_items i JOIN threads t ON t.id = i.thread_id
            WHERE t.owner_user_id = ${owner}::uuid AND i.type = 'background_task' AND i.status = 'in_progress'
              AND t.worker_id = ANY(${online}::uuid[]))
          OR EXISTS (SELECT 1 FROM bot_turns b JOIN bots o ON o.id = b.bot_id
            WHERE o.owner_user_id = ${owner}::uuid AND b.status IN ('queued', 'running'))
          OR EXISTS (SELECT 1 FROM turns u JOIN threads t ON t.id = u.thread_id
            WHERE t.owner_user_id = ${owner}::uuid
              AND greatest(u.queued_at, coalesce(u.started_at, u.queued_at), coalesce(u.completed_at, u.queued_at))
                > now() - ${quiet}::interval) AS busy`;
      }).pipe(queryFamily("updates.store"), queryRpc),
    );

    return Boolean(rows[0]?.enabled && !rows[0].busy);
  }
}
