import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export type ThreadHistoryQuery = Pick<
  ui.WatchThreadRequest,
  "pageSize" | "beforeTurnId" | "targetItemId" | "historyVersion" | "fromTurnId"
>;

/** Select complete turns before decoding timeline content. The chain and page share the snapshot's MVCC read. */
export function threadWindow(sql: SqlClient.SqlClient, thread: string, version: string, query?: ThreadHistoryQuery) {
  return Effect.gen(function* () {
    if (!query?.pageSize) return undefined;
    const moved = yield* sql`SELECT thread_id FROM computer_moved_threads WHERE thread_id=${thread}::uuid`;

    if (moved.length) return undefined;

    const turns = yield* sql<{ id: string }>`SELECT u.id FROM thread_fork_chain(${thread}::uuid) c
      JOIN turns u ON u.thread_id=c.thread_id WHERE u.status<>'queued'
        AND (c.upto_seq IS NULL OR u.last_seq<=c.upto_seq)
      ORDER BY c.level DESC,u.ordinal`;

    const reset = !!query.historyVersion && query.historyVersion !== version;

    const boundary =
      !reset && query.beforeTurnId ? turns.findIndex((turn) => turn.id === query.beforeTurnId) : turns.length;

    const end = boundary < 0 ? turns.length : boundary;

    const target =
      !reset && query.targetItemId
        ? (yield* sql<{ turn_id: string }>`SELECT turn_id FROM thread_items_view(${thread}::uuid)
          WHERE item_id=${query.targetItemId} LIMIT 1`)[0]
        : undefined;

    const targetIndex = target ? turns.findIndex((turn) => turn.id === target.turn_id) : -1;
    const fromIndex = !reset && query.fromTurnId ? turns.findIndex((turn) => turn.id === query.fromTurnId) : -1;

    const start =
      targetIndex >= 0 ? targetIndex : fromIndex >= 0 ? fromIndex : Math.max(0, end - Math.min(query.pageSize, 100));

    const selected = turns.slice(start, end);
    const queued = yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id=${thread}::uuid AND status='queued'`;

    return {
      ids: [...selected, ...queued].map((turn) => turn.id),
      before: selected[0]?.id ?? "",
      hasMore: start > 0,
      reset: reset || boundary < 0 || (!!query.fromTurnId && fromIndex < 0),
    };
  });
}
