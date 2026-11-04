import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ThreadEventSchema, ui, type Item } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fx } from "./errors.ts";
import type { ThreadRow, TurnRow } from "./rows.ts";
import type { InteractionStore } from "./interactions-store.ts";
import type { ThreadStore } from "./threads-store.ts";
import type { TurnStore } from "./turns-store.ts";

export interface ThreadSnapshotStore {
  snapshot(threadId: string): Fx<{
    thread: ThreadRow;
    turns: (TurnRow & { inherited?: boolean })[];
    items: ui.TimelineItem[];
    interactions: ui.Interaction[];
    notices: ui.ThreadNotice[];
    lastSeq: bigint;
  }>;
  /** Current state of one of the thread's own items. */
  threadItem(threadId: string, itemId: string): Fx<Item | undefined>;
}

export function threadSnapshot(
  sql: SqlClient.SqlClient,
  self: () => Pick<ThreadStore, "thread"> & Pick<TurnStore, "turnsOf"> & Pick<InteractionStore, "pendingInteractions">,
): ThreadSnapshotStore {
  return {
    snapshot: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* self().thread(threadId);

        // A fork shows the history it inherits (thread_items_view / thread_fork_chain), marked as inherited.
        const inheritedTurns = yield* sql<TurnRow>`
                SELECT u.*, s.*, (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id WHERE bc.id = u.bot_call_id) AS bot_id FROM thread_fork_chain(${threadId}::uuid) c
                  JOIN turns u ON u.thread_id = c.thread_id LEFT JOIN turn_sources s ON s.turn_id = u.id
                 WHERE c.level > 0 AND u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)
                 ORDER BY c.level DESC, u.ordinal`;

        const turns = yield* self().turnsOf(threadId);

        const itemRows = yield* sql<{
          thread_id: string;
          content: JsonValue;
          turn_id: string | null;
          first_seq: bigint;
          last_seq: bigint;
          inherited: boolean;
        }>`
                SELECT thread_id, content, turn_id, first_seq, last_seq, inherited FROM thread_items_view(${threadId}::uuid)`;

        const items = itemRows.map((r) =>
          create(ui.TimelineItemSchema, {
            item: fromJson(ItemSchema, r.content),
            turnId: r.turn_id ?? "",
            firstSeq: BigInt(r.first_seq),
            lastSeq: BigInt(r.last_seq),
            inherited: r.inherited,
            fromThreadId: r.inherited ? r.thread_id : "",
          }),
        );

        const noticeRows = yield* sql<{
          seq: bigint;
          turn_id: string | null;
          payload: JsonValue;
          occurred_at: Date;
        }>`
                SELECT seq, turn_id, payload, occurred_at FROM (
                  SELECT seq, turn_id, payload, occurred_at FROM thread_events
                   WHERE thread_id = ${threadId}::uuid AND kind = 'notice' ORDER BY seq DESC LIMIT 200) n
                 ORDER BY seq`;

        const notices = noticeRows.flatMap((r) => {
          const event = fromJson(ThreadEventSchema, r.payload);

          return event.body.case === "notice"
            ? [
                create(ui.ThreadNoticeSchema, {
                  seq: BigInt(r.seq),
                  turnId: r.turn_id ?? "",
                  notice: event.body.value,
                  occurredAt: timestampFromDate(new Date(r.occurred_at)),
                }),
              ]
            : [];
        });

        const interactions = yield* self().pendingInteractions(threadId);

        return {
          thread,
          turns: [...inheritedTurns.map((t) => ({ ...t, inherited: true })), ...turns],
          items,
          interactions,
          notices,
          lastSeq: BigInt(thread.last_seq),
        };
      }),

    threadItem: (threadId, itemId) =>
      sql<{
        content: JsonValue;
      }>`SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId}`.pipe(
        Effect.map((rows) => (rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined)),
      ),
  };
}
