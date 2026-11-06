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
import { mirrorSelection, type MirrorSelection } from "./mirror-selection.ts";

export interface ThreadSnapshotStore {
  snapshot(
    threadId: string,
    mirrorCursor?: string,
    includeCursor?: boolean,
  ): Fx<{
    thread: ThreadRow;
    turns: (TurnRow & { inherited?: boolean })[];
    items: ui.TimelineItem[];
    interactions: ui.Interaction[];
    notices: ui.ThreadNotice[];
    lastSeq: bigint;
    selection: MirrorSelection | undefined;
    cursor: string;
  }>;
  /** Current state of one of the thread's own items. */
  threadItem(threadId: string, itemId: string): Fx<Item | undefined>;
}

export function threadSnapshot(
  sql: SqlClient.SqlClient,
  self: () => Pick<ThreadStore, "thread"> & Pick<TurnStore, "turnsOf"> & Pick<InteractionStore, "pendingInteractions">,
): ThreadSnapshotStore {
  return {
    snapshot: (threadId, mirrorCursor, includeCursor) => {
      const read = Effect.gen(function* () {
        const thread = yield* self().thread(threadId);

        const clock = includeCursor
          ? (yield* sql<{ cursor: string }>`SELECT epoch::text || ':' || revision::text AS cursor
                FROM computer_thread_clock WHERE owner_user_id=${thread.owner_user_id}::uuid`)[0]
          : undefined;

        const selection = mirrorCursor
          ? yield* mirrorSelection(sql, thread.owner_user_id, threadId, mirrorCursor)
          : undefined;

        // A fork shows the history it inherits (thread_items_view / thread_fork_chain), marked as inherited.
        const inheritedTurns = selection
          ? []
          : yield* sql<TurnRow>`
                SELECT u.*, s.*, (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id = bc.turn_id WHERE bc.id = u.bot_call_id) AS bot_id FROM thread_fork_chain(${threadId}::uuid) c
                  JOIN turns u ON u.thread_id = c.thread_id LEFT JOIN turn_sources s ON s.turn_id = u.id
                 WHERE c.level > 0 AND u.status <> 'queued' AND (c.upto_seq IS NULL OR u.last_seq <= c.upto_seq)
                 ORDER BY c.level DESC, u.ordinal`;

        const turns = yield* self().turnsOf(threadId, selection?.turnIds);

        type ItemRow = {
          thread_id: string;
          content: JsonValue;
          turn_id: string | null;
          first_seq: bigint;
          last_seq: bigint;
          inherited: boolean;
          completed_at: Date | null;
        };

        const itemRows = selection
          ? yield* sql<ItemRow>`SELECT v.thread_id,v.content,v.turn_id,v.first_seq,v.last_seq,false AS inherited,
                  e.occurred_at AS completed_at
                FROM thread_items v LEFT JOIN thread_events e ON v.type='agent_message' AND v.status='completed'
                  AND e.thread_id=v.thread_id AND e.seq=v.last_seq
                WHERE v.thread_id=${threadId}::uuid AND v.item_id=ANY(${selection.itemIds}::text[])
                ORDER BY v.first_seq`
          : yield* sql<ItemRow>`SELECT v.thread_id,v.content,v.turn_id,v.first_seq,v.last_seq,v.inherited,
                  e.occurred_at AS completed_at
                FROM thread_items_view(${threadId}::uuid) WITH ORDINALITY v
                LEFT JOIN thread_events e ON v.type='agent_message' AND v.status='completed'
                  AND e.thread_id=v.thread_id AND e.seq=v.last_seq ORDER BY v.ordinality`;

        const items = itemRows.map((r) =>
          create(ui.TimelineItemSchema, {
            item: fromJson(ItemSchema, r.content),
            turnId: r.turn_id ?? "",
            firstSeq: BigInt(r.first_seq),
            lastSeq: BigInt(r.last_seq),
            inherited: r.inherited,
            fromThreadId: r.inherited ? r.thread_id : "",
            // When a shown answer ended: the start of the turn's next segment (docs/timeline-folding.md).
            ...(r.completed_at && { completedAt: timestampFromDate(new Date(r.completed_at)) }),
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
                   WHERE thread_id = ${threadId}::uuid AND kind = 'notice'
                     AND (${selection === undefined} OR seq=ANY(${selection?.noticeSeqs ?? []}::bigint[]))
                   ORDER BY seq DESC LIMIT ${selection ? null : 200}) n
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
          selection,
          cursor: clock?.cursor ?? "",
        };
      });

      // Ordinary snapshots also run inside writable bot actions; preserve their transaction.
      return mirrorCursor || includeCursor
        ? sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

              return yield* read;
            }),
          )
        : read;
    },

    threadItem: (threadId, itemId) =>
      sql<{
        content: JsonValue;
      }>`SELECT content FROM thread_items WHERE thread_id = ${threadId}::uuid AND item_id = ${itemId}`.pipe(
        Effect.map((rows) => (rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined)),
      ),
  };
}
