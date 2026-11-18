import type { ThreadEvent } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { ownerModule } from "./module-access.ts";
import { THREADS_DISABLED_REASON } from "./module-worker-commands.ts";

const changesExecution = (event: ThreadEvent) =>
  event.body.case === "turnStarted" ||
  event.body.case === "turnFinished" ||
  event.body.case === "activity" ||
  event.body.case === "goalState";

/** Read after acquiring the lifecycle lock. Reuse the rewind lookup for both fences on execution events. */
export function ingestEventFence(
  sql: SqlClient.SqlClient,
  owner: string,
  threadId: string,
  events: readonly ThreadEvent[],
) {
  const lifecycle = events.filter(changesExecution);
  const enabled = lifecycle.length ? ownerModule(sql, owner, "threads") : sql`TRUE`;

  const closing = lifecycle.length
    ? sql`EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = ${threadId}::uuid
        AND c.kind = 'unloadThread' AND c.status IN ('pending','delivered'))`
    : sql`FALSE`;

  const ids = lifecycle.flatMap((event) => (event.turnId ? [event.turnId] : []));

  const stopped = ids.length
    ? sql`OR (u.interrupt_reason = ${THREADS_DISABLED_REASON} AND u.id::text = ANY(${ids}::text[]))`
    : sql``;

  return sql<{ enabled: boolean; closing: boolean; id: string | null; rewound: boolean }>`
    SELECT gate.enabled, gate.closing, u.id, u.rewind_id IS NOT NULL AS rewound FROM (SELECT ${enabled} AS enabled, ${closing} AS closing) gate
    LEFT JOIN turns u ON u.thread_id = ${threadId}::uuid AND (u.rewind_id IS NOT NULL ${stopped})`.pipe(
    Effect.map((rows) => {
      const superseded = new Set<string>();
      const interrupted = new Set<string>();

      for (const row of rows) {
        if (row.id) (row.rewound ? superseded : interrupted).add(row.id);
      }

      const gate = rows[0]!;

      return (event: ThreadEvent) =>
        superseded.has(event.turnId) ||
        (changesExecution(event) &&
          (!gate.enabled || interrupted.has(event.turnId) || (gate.closing && event.body.case !== "turnFinished")));
    }),
  );
}
