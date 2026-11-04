import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ThreadEventSchema } from "@canopy/contracts";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { StoredEvent } from "./ingest.ts";
import { ENDED, applyItem, insertEvent } from "./ingest-events.ts";

/** No turn of the thread runs. */
export const idleTurns = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = ${threadId}::uuid AND r.status = 'running')`;

/**
 * Items settle() closes: open, not a background task (those outlive turns; the worker ends them with their
 * process), not a command a running background task continues (Codex keeps its item open until the process
 * exits), in a finished turn, or outside any turn while none runs.
 */
export const openLeftovers = (sql: SqlClient.SqlClient, threadId: string) => sql<{
  item_id: string;
  turn_id: string | null;
  content: JsonValue;
}>`
  SELECT i.item_id, i.turn_id, i.content FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
   WHERE i.thread_id = ${threadId}::uuid AND i.status = 'in_progress' AND i.type NOT IN ('background_task', 'interaction_prompt')
     AND (u.status = ANY(${ENDED}::text[]) OR (i.turn_id IS NULL AND ${idleTurns(sql, threadId)}))
     AND NOT EXISTS (SELECT 1 FROM thread_items b
                      WHERE b.thread_id = i.thread_id AND b.type = 'background_task' AND b.status = 'in_progress'
                        AND b.content->'backgroundTask'->>'sourceItemId' = i.item_id)
   ORDER BY i.first_seq`;

/** A thread whose status says it works or failed while it can take the next turn. */
export const stuckThread = (sql: SqlClient.SqlClient, staleSeconds: number) => sql`
  t.archived_at IS NULL AND (
    t.status = 'interrupted'
    OR (t.status = 'failed' AND t.provider_thread_id IS NOT NULL)
    OR (t.status IN ('running', 'waiting_input') AND t.updated_at <= now() - make_interval(secs => ${staleSeconds})
        AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = t.id AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id AND c.kind = 'startTurn' AND c.status IN ('pending', 'delivered'))))`;

export const settleThread = (sql: SqlClient.SqlClient, threadId: string, reason: string, staleSeconds: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const locked = yield* sql<{
        last_seq: string;
      }>`SELECT last_seq FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;

      if (!locked[0]) return { stored: [], threadChanged: false };
      let last = BigInt(locked[0].last_seq);
      const stored: StoredEvent[] = [];

      for (const row of yield* openLeftovers(sql, threadId)) {
        const item = fromJson(ItemSchema, row.content);
        item.status = ItemStatus.INTERRUPTED;

        const event = create(ThreadEventSchema, {
          eventId: Bun.randomUUIDv7(),
          threadId,
          turnId: row.turn_id ?? "",
          occurredAt: timestampNow(),
          // The audit trail: who closed the item and why (thread_events.raw).
          rawJson: JSON.stringify({ settled_by: "gateway", reason }),
          body: { case: "itemCompleted", value: { item } },
        });

        const seq = ++last;
        yield* insertEvent(sql, threadId, seq, event, "gateway");
        yield* applyItem(sql, threadId, seq, event);
        stored.push({ threadId, seq, event });
      }

      if (stored.length > 0) yield* sql`UPDATE threads SET last_seq = ${last} WHERE id = ${threadId}::uuid`;

      const changed = yield* sql`
        UPDATE threads t SET status = 'idle', status_detail = NULL
         WHERE t.id = ${threadId}::uuid AND ${stuckThread(sql, staleSeconds)}
        RETURNING t.id`;

      return { stored, threadChanged: changed.length > 0 };
    }),
  );
