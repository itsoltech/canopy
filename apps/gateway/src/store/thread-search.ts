import { fuzzyRank } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ThreadRow } from "./rows.ts";
import { listThreadSelect } from "./thread-select.ts";

/** Rank small headers first; only matches need notification previews and the full UI metadata. */
export function searchThreads(sql: SqlClient.SqlClient, owner: string, query: string, exclude: string, limit: number) {
  return Effect.gen(function* () {
    const candidates = yield* sql<{ id: string; title: string; activity: Date }>`
      SELECT t.id,t.title,greatest(t.created_at,
        (SELECT greatest(u.queued_at,coalesce(u.started_at,u.queued_at),coalesce(u.completed_at,u.queued_at))
          FROM turns u WHERE u.thread_id=t.id
          ORDER BY greatest(u.queued_at,coalesce(u.started_at,u.queued_at),coalesce(u.completed_at,u.queued_at)) DESC
          LIMIT 1)) AS activity
      FROM threads t WHERE t.owner_user_id=${owner}::uuid AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.id::text<>${exclude}
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.archived_at IS NULL)
      ORDER BY t.created_at`;

    const ordered = [...candidates].sort((a, b) => b.activity.getTime() - a.activity.getTime());
    const ranked = fuzzyRank(query, ordered, (t) => [t.title || "Untitled"], Math.min(limit || 20, 50));

    if (!ranked.length) return [];

    const rows = yield* sql.unsafe<ThreadRow>(
      listThreadSelect(`WHERE t.owner_user_id=$1::uuid
      AND t.id=ANY($2::uuid[]) AND t.deleted_at IS NULL AND t.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.archived_at IS NULL)`),
      [owner, ranked.map((r) => r.item.id)],
    );

    const byId = new Map(rows.map((row) => [row.id, row]));

    return ranked.flatMap(({ item }) => {
      const row = byId.get(item.id);

      return row ? [row] : [];
    });
  });
}
