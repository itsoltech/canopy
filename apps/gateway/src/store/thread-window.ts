import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export type ThreadHistoryQuery = { bounded?: boolean } & Pick<
  ui.WatchThreadRequest,
  "pageSize" | "beforeTurnId" | "targetItemId" | "historyVersion" | "fromTurnId"
>;

/** Select complete turns before decoding timeline content. The chain and page share the snapshot's MVCC read. */
export function threadWindow(sql: SqlClient.SqlClient, thread: string, version: string, query?: ThreadHistoryQuery) {
  return Effect.gen(function* () {
    if (!query?.pageSize) return undefined;
    const moved = yield* sql`SELECT thread_id FROM computer_moved_threads WHERE thread_id=${thread}::uuid`;

    if (moved.length) return undefined;

    const reset = !!query.historyVersion && query.historyVersion !== version;

    const target =
      !reset && query.targetItemId
        ? (yield* sql<{ turn_id: string }>`SELECT turn_id FROM thread_items_view(${thread}::uuid)
          WHERE item_id=${query.targetItemId} LIMIT 1`)[0]
        : undefined;

    // Locate anchors by primary key, then page by the fork depth and ordinal. Only the
    // requested window crosses the SQL boundary, even for a thread with years of turns.
    const page = (yield* sql<{ ids: string[]; before: string | null; has_more: boolean; missing: boolean }>`
      WITH chain AS MATERIALIZED (SELECT * FROM thread_fork_chain(${thread}::uuid)), eligible AS NOT MATERIALIZED (
        SELECT u.id,-c.level AS depth,u.ordinal FROM chain c
        JOIN turns u ON u.thread_id=c.thread_id WHERE u.status<>'queued'
          AND (c.upto_seq IS NULL OR u.last_seq<=c.upto_seq)
      ), bounds AS (
        SELECT b.depth AS end_depth,b.ordinal AS end_ordinal,
          coalesce(t.depth,f.depth) AS start_depth,coalesce(t.ordinal,f.ordinal) AS start_ordinal,
          (${!reset && !!query.beforeTurnId} AND b.id IS NULL) OR
            (${!!query.fromTurnId} AND f.id IS NULL) AS missing
        FROM (SELECT 1) seed
        LEFT JOIN eligible b ON b.id=${reset ? null : query.beforeTurnId || null}::uuid
        LEFT JOIN eligible f ON f.id=${reset ? null : query.fromTurnId || null}::uuid
        LEFT JOIN eligible t ON t.id=${target?.turn_id ?? null}::uuid
      ), page AS MATERIALIZED (
        SELECT e.* FROM chain c CROSS JOIN bounds b CROSS JOIN LATERAL (
          SELECT u.id,-c.level AS depth,u.ordinal FROM turns u
          WHERE u.thread_id=c.thread_id AND u.status<>'queued'
            AND (c.upto_seq IS NULL OR u.last_seq<=c.upto_seq)
            AND (b.end_depth IS NULL OR (-c.level,u.ordinal)<(b.end_depth,b.end_ordinal))
            AND (b.start_depth IS NULL OR (-c.level,u.ordinal)>=(b.start_depth,b.start_ordinal))
          ORDER BY u.ordinal DESC LIMIT CASE WHEN b.start_depth IS NULL THEN ${Math.min(query.pageSize, 100)} END
        ) e
        ORDER BY e.depth DESC,e.ordinal DESC
        LIMIT (SELECT CASE WHEN start_depth IS NULL THEN ${Math.min(query.pageSize, 100)} END FROM bounds)
      ), first_turn AS (SELECT * FROM page ORDER BY depth,ordinal LIMIT 1)
      SELECT ARRAY(SELECT id FROM page ORDER BY depth,ordinal) AS ids,
        (SELECT id FROM first_turn) AS before,
        EXISTS(SELECT 1 FROM eligible e,first_turn f WHERE (e.depth,e.ordinal)<(f.depth,f.ordinal)) AS has_more,
        (SELECT missing FROM bounds) AS missing`)[0]!;

    const queued = yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id=${thread}::uuid AND status='queued'`;

    return {
      ids: [...page.ids, ...queued.map((turn) => turn.id)],
      before: page.before ?? "",
      hasMore: page.has_more,
      reset: reset || page.missing,
    };
  });
}
