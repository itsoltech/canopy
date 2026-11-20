import { create } from "@bufbuild/protobuf";
import { InteractionKind, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { queryFamily } from "../diagnostics/query-context.ts";
import { GatewayStore } from "./store.ts";
import type { ItemRow } from "./thread-snapshot.ts";
import { decodeTimelineItem } from "./timeline-item.ts";

/** Check the owner and the pending rows in the same snapshot as their approval details. */
export function threadRequestSnapshot(owner: string, thread: string, previous?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

        // Polling also sees commits on another gateway. Touch only the pending index
        // and related item keys until a row changes; large file diffs stay in Postgres.
        const [state] = yield* sql<{ revision: string }>`SELECT coalesce(string_agg(
            q.id::text || ':' || q.xmin::text || ':' || coalesce(i.xmin::text,''),
            ',' ORDER BY q.id),'') AS revision
          FROM threads t LEFT JOIN interaction_requests q ON q.thread_id=t.id AND q.status='pending'
          LEFT JOIN thread_items i ON q.kind='permission' AND i.thread_id=q.thread_id AND i.item_id=q.item_id
            AND i.type IN ('command_execution','file_change')
          WHERE t.id=${thread}::uuid AND t.owner_user_id=${owner}::uuid AND t.deleted_at IS NULL GROUP BY t.id`;

        if (!state) return yield* Effect.fail(new ConnectError("Thread not found", Code.NotFound));

        if (state.revision === previous) return undefined;
        const store = yield* GatewayStore;
        const interactions = yield* store.pendingInteractions(thread);

        const related = interactions.flatMap((q) =>
          q.kind === InteractionKind.PERMISSION && q.itemId ? [q.itemId] : [],
        );

        const items = related.length
          ? yield* sql<ItemRow>`SELECT thread_id,item_id,turn_id,first_seq,last_seq,false AS inherited,NULL AS completed_at,
                CASE WHEN type='command_execution' THEN jsonb_set(content - 'command_execution','{commandExecution}',
                  coalesce(content->'commandExecution',content->'command_execution','{}'::jsonb)
                  - ARRAY['output','outputBlob','output_blob']) ELSE content END AS content
              FROM thread_items WHERE thread_id=${thread}::uuid AND item_id=ANY(${related}::text[])
                AND type IN ('command_execution','file_change') ORDER BY first_seq,item_id`
          : [];

        return {
          revision: state.revision,
          related: new Set(related),
          snapshot: create(ui.ThreadSnapshotSchema, { interactions, items: items.map(decodeTimelineItem) }),
        };
      }),
    );
  }).pipe(queryFamily("thread.read"));
}
