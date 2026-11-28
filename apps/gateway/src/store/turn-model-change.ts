import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemStatus, ThreadEventSchema, type ProfileModels, type ThreadEvent } from "@canopy/contracts";
import { eventItemId } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { applyItem, insertEvent } from "./ingest-events.ts";
import { findModel } from "./models.ts";

interface Selection {
  model: string;
  effort: string;
}

const ITEM_PREFIX = "model-change-";

/** Both live worker journals and import pages are outside this item's authoring boundary. */
export function modelChangeEvent(event: ThreadEvent): boolean {
  const body = event.body;

  return (
    Boolean(eventItemId(body)?.startsWith(ITEM_PREFIX)) ||
    ((body.case === "itemStarted" || body.case === "itemCompleted") && body.value.item?.content.case === "modelChange")
  );
}

/** Under the queue's admission lock, alongside the StartTurn outbox entry. */
export function recordTurnModelChange(threadId: string, turnId: string, selection: Selection, catalog?: ProfileModels) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Follow the visible fork prefix. Within each thread use execution order, including restored queue entries.
    const [previous] = yield* sql<Selection>`SELECT p.model,p.effort FROM thread_fork_chain(${threadId}::uuid) c
      CROSS JOIN LATERAL (
        SELECT u.model,u.effort FROM worker_commands cmd JOIN turns u ON u.id=cmd.turn_id
        WHERE cmd.thread_id=c.thread_id AND cmd.kind='startTurn' AND u.id<>${turnId}::uuid
          AND u.withdrawn IS NULL AND (CASE WHEN c.level=0 THEN u.rewind_id IS NULL
            ELSE u.last_seq<=c.upto_seq AND thread_turn_visible_at(u.id,c.upto_seq) END)
        ORDER BY cmd.created_at DESC,cmd.id DESC
        LIMIT 1
      ) p ORDER BY c.level LIMIT 1`;

    if (!previous || (previous.model === selection.model && previous.effort === selection.effort)) return;
    const before = catalog && previous.model ? findModel(catalog, previous.model) : undefined;
    const after = catalog && selection.model ? findModel(catalog, selection.model) : undefined;

    if (before && after && before.id === after.id && previous.effort === selection.effort) return;
    const itemId = `${ITEM_PREFIX}${turnId}`;

    const event = create(ThreadEventSchema, {
      eventId: Bun.randomUUIDv7(),
      threadId,
      turnId,
      occurredAt: timestampNow(),
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId,
            status: ItemStatus.COMPLETED,
            content: {
              case: "modelChange",
              value: {
                previousModel: previous.model,
                previousEffort: previous.effort,
                ...selection,
                previousModelName: before?.displayName ?? "",
                modelName: after?.displayName ?? "",
              },
            },
          },
        },
      },
    });

    const [row] = yield* sql<{ last_seq: string }>`UPDATE threads SET last_seq=last_seq+1 WHERE id=${threadId}::uuid
      AND NOT EXISTS (SELECT 1 FROM thread_items WHERE thread_id=${threadId}::uuid AND item_id=${itemId})
      RETURNING last_seq`;

    if (!row) return;
    const seq = BigInt(row.last_seq);
    yield* insertEvent(sql, threadId, seq, event, "gateway");
    yield* applyItem(sql, threadId, seq, event);

    return { seq, event };
  });
}
