import type { bots } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import { botThreadConnection } from "../store/module-access.ts";
import { BLOCKING_THREAD_INTERACTION } from "../store/thread-select.ts";
import { DISPATCHED } from "../store/turn-select.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

export type DelegatedThreadCounts = Pick<bots.BotDelegatedThreads, "working" | "finished">;

/** One current state per retained thread, using the same start and blocking-input signals as the Threads list. */
export function delegatedThreadCounts(core: GatewayCore): Promise<ReadonlyMap<string, DelegatedThreadCounts>> {
  const { runtime, userId } = core[coreState].options;

  return runtime.runPromise(
    SqlClient.SqlClient.use(
      (sql) => sql<DelegatedThreadCounts & { id: string }>`
        SELECT b.id::text, count(*) FILTER (WHERE d.state = 'working')::int AS working,
          count(*) FILTER (WHERE d.state = 'finished')::int AS finished
        FROM bots b
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN t.status = 'waiting_input' OR EXISTS (
              SELECT 1 FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending'
                AND (${sql.literal(BLOCKING_THREAD_INTERACTION)})
            ) THEN NULL
            WHEN t.status IN ('creating', 'running') OR EXISTS (
              SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued'
                AND u.rewind_id IS NULL AND ${sql.literal(DISPATCHED)}
            ) THEN 'working'
            WHEN t.rewind_pending_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id
                AND u.status IN ('queued', 'running') AND u.rewind_id IS NULL)
              AND NOT EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = t.id
                AND i.type = 'background_task' AND i.status = 'in_progress')
              AND (t.status IN ('failed', 'interrupted') OR EXISTS (
                SELECT 1 FROM turns u WHERE u.thread_id = t.id
                  AND u.status IN ('completed', 'failed', 'interrupted') AND u.rewind_id IS NULL
              )) THEN 'finished'
          END AS state
          FROM bot_started_threads s JOIN threads t ON t.id = s.thread_id
          WHERE s.bot_id = b.id AND t.owner_user_id = b.owner_user_id
            AND t.archived_at IS NULL AND t.deleted_at IS NULL
        ) d ON true
        WHERE b.owner_user_id = ${userId}::uuid AND b.deleted_at IS NULL AND b.moved_to IS NULL
          AND ${botThreadConnection(sql, userId)}
        GROUP BY b.id`,
    ).pipe(
      Effect.map((rows) => new Map(rows.map(({ id, working, finished }) => [id, { working, finished }]))),
      queryFamily("overview.feeds"),
      queryRpc,
    ),
  );
}
