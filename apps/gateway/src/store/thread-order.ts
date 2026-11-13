import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Position {
  id: string;
  project_id: string;
  key: string;
}

/** Owner serialization prevents concurrent moves/creates from allocating the same gap. Only the moved row is written. */
export function reorderThread(sql: SqlClient.SqlClient, owner: string, request: ui.ReorderThreadRequest) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const { threadId, afterThreadId, beforeThreadId } = request;
      const ids = [threadId, afterThreadId, beforeThreadId].filter(Boolean);

      if (!threadId || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length)
        return yield* Effect.fail(new Invalid("Choose different threads for the move. Try again."));

      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.thread_order:' || ${owner}::text, 0))`;

      const rows = yield* sql<Position>`SELECT id, project_id,
          coalesce(sidebar_order_key, thread_creation_order(created_at, id)) AS key
        FROM threads WHERE owner_user_id = ${owner}::uuid AND id = ANY(${ids}::uuid[])
          AND deleted_at IS NULL AND archived_at IS NULL AND origin <> 'agent'
        ORDER BY id FOR SHARE`;

      const thread = rows.find((row) => row.id === threadId);

      if (!thread || rows.length !== ids.length)
        return yield* Effect.fail(new NotFound("Thread unavailable. Refresh the list and try again."));

      if (request.withinProject && rows.some((row) => row.project_id !== thread.project_id))
        return yield* Effect.fail(new Invalid("Move threads within the same project. Try again."));

      const lo = rows.find((row) => row.id === afterThreadId)?.key ?? null;
      let hi = rows.find((row) => row.id === beforeThreadId)?.key ?? null;

      if (lo !== null && hi !== null && lo >= hi)
        return yield* Effect.fail(new Invalid("The order changed elsewhere. Refresh the list and try again."));

      // Another device may have filled this gap since it was rendered. Allocate before its first key.
      const next = yield* sql<{
        key: string;
      }>`SELECT coalesce(sidebar_order_key, thread_creation_order(created_at, id)) AS key
        FROM threads WHERE owner_user_id = ${owner}::uuid AND id <> ${threadId}::uuid
          AND deleted_at IS NULL AND archived_at IS NULL
          AND (${lo}::text IS NULL OR coalesce(sidebar_order_key, thread_creation_order(created_at, id)) COLLATE "C" > ${lo}::text COLLATE "C")
          AND (${hi}::text IS NULL OR coalesce(sidebar_order_key, thread_creation_order(created_at, id)) COLLATE "C" < ${hi}::text COLLATE "C")
        ORDER BY coalesce(sidebar_order_key, thread_creation_order(created_at, id)) COLLATE "C" LIMIT 1`;

      hi = next[0]?.key ?? hi;

      yield* sql`UPDATE threads SET sidebar_order_key = thread_order_between(${lo}::text, ${hi}::text)
        WHERE id = ${threadId}::uuid AND owner_user_id = ${owner}::uuid`;
    }),
  );
}
