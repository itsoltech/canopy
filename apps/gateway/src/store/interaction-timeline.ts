import { create, toJson } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { InteractionKind, ItemSchema, ItemStatus, ThreadEventSchema } from "@canopy/contracts";
import { Effect, Match } from "effect";
import type { SqlClient } from "effect/sql";
import type { InteractionRow } from "./store.ts";

/** Written in the interaction's transaction, under the same thread lock as worker events. */
export function writeInteractionTimeline(sql: SqlClient.SqlClient, row: InteractionRow) {
  return Effect.gen(function* () {
    const itemId = `interaction-${row.id}`;
    const pending = row.status === "pending";
    const response = row.response;

    const item = create(ItemSchema, {
      itemId,
      status: pending ? ItemStatus.IN_PROGRESS : ItemStatus.COMPLETED,
      content: {
        case: "interactionPrompt",
        value: {
          requestId: row.id,
          kind: Match.value(row.kind).pipe(
            Match.when("question", () => InteractionKind.QUESTION),
            Match.when("permission", () => InteractionKind.PERMISSION),
            Match.orElse(() => InteractionKind.ELICITATION),
          ),
          toolName: row.tool_name,
          requestJson: JSON.stringify(row.request),
          responseJson: response?.answerJson || (response ? JSON.stringify(response) : ""),
          answeredByUserId: row.answered_by ?? "",
          answeredByThreadId: row.answered_by_thread_id ?? "",
          outcome: pending ? "" : row.status,
          routedTo: row.routed_to,
          asynchronous: row.question_wait === false,
        },
      },
    });

    const locked = yield* sql<{
      last_seq: string;
    }>`SELECT last_seq FROM threads WHERE id = ${row.thread_id}::uuid FOR UPDATE`;

    const seq = BigInt(locked[0]!.last_seq) + 1n;

    const event = create(ThreadEventSchema, {
      eventId: Bun.randomUUIDv7(),
      threadId: row.thread_id,
      turnId: row.turn_id ?? "",
      occurredAt: timestampNow(),
      body: { case: pending ? "itemStarted" : "itemCompleted", value: { item } },
    });

    yield* sql`
      INSERT INTO thread_events(thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, occurred_at)
      VALUES (${row.thread_id}::uuid, ${seq}, ${event.eventId}::uuid, 'gateway', ${row.turn_id}::uuid,
              ${pending ? "item_started" : "item_completed"}, ${itemId}, ${JSON.stringify(toJson(ThreadEventSchema, event))}::jsonb, now())`;
    yield* sql`
      INSERT INTO thread_items(thread_id, item_id, turn_id, type, status, content, first_seq, last_seq)
      VALUES (${row.thread_id}::uuid, ${itemId}, ${row.turn_id}::uuid, 'interaction_prompt', ${pending ? "in_progress" : "completed"},
              ${JSON.stringify(toJson(ItemSchema, item))}::jsonb, ${seq}, ${seq})
      ON CONFLICT(thread_id, item_id) DO UPDATE SET status = EXCLUDED.status, content = EXCLUDED.content, last_seq = EXCLUDED.last_seq`;
    yield* sql`UPDATE threads SET last_seq = ${seq} WHERE id = ${row.thread_id}::uuid`;
  });
}
