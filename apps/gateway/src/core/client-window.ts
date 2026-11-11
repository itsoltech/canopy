import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { projectRange } from "../computers/range-projection.ts";
import { compactRangeRecord } from "../computers/range-content.ts";
import { rangeResult } from "../computers/range-effects.ts";
import type { RangeSourceStore } from "../computers/range-source.ts";
import { prepareRangeClock } from "../computers/range-clock.ts";
import { clientWindowKeys } from "./client-window-keys.ts";
import { appendClientWindow } from "../computers/range-window-records.ts";

/** The window and sequence checkpoint share the source commit barrier. */
export async function readClientWindow(store: RangeSourceStore, input: ui.WatchThreadRequest) {
  return store.runtime
    .runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const clock = yield* prepareRangeClock(sql, store, input.threadId);

              const reset = !!input.historyVersion && input.historyVersion !== clock.epoch;

              const request = reset
                ? create(ui.WatchThreadRequestSchema, { ...input, beforeItemId: "", beforeTurnId: "" })
                : input;

              const page = yield* clientWindowKeys(sql, input.threadId, request);
              const projected = yield* projectRange(input.threadId, page.keys);

              const snapshot = create(ui.ThreadSnapshotSchema, {
                syncCursor: { threadId: input.threadId, epoch: clock.epoch, appliedSeq: BigInt(clock.head_seq) },
                cursor: `range:${clock.epoch}:${clock.head_seq}`,
                historyVersion: clock.epoch,
                historyReset: reset,
                historyBeforeTurnId: page.beforeTurn,
                historyBeforeItemId: page.beforeItem,
                historyHasMore: page.turnsMore,
                historyItemsHasMore: page.itemsMore,
              });

              // Header first; history is added newest-first and published in timeline order.
              const ordered = projected.sort(
                (a, b) => Number(b.value.case === "thread") - Number(a.value.case === "thread"),
              );

              const records: ui.ThreadSyncRecord[] = [];
              const sizes = new Map<ui.ThreadSyncRecord, number>();

              for (const record of ordered) {
                const compact = compactRangeRecord(record);

                if (compact.content)
                  yield* sql`INSERT INTO thread_replication_content(thread_id,sha256,data)
          VALUES(${input.threadId}::uuid,${compact.content.sha256},${compact.content.data}) ON CONFLICT DO NOTHING`;
                records.push(compact.record);
                sizes.set(compact.record, compact.data.length);
              }

              appendClientWindow(snapshot, records, page.turnIds, sizes);
              snapshot.lastSeq = snapshot.thread?.lastSeq ?? 0n;
              yield* sql`UPDATE thread_replication_clock SET checkpoint_seq=head_seq WHERE thread_id=${input.threadId}::uuid`;

              return snapshot;
            }),
          );
        }),
      ),
    )
    .then(rangeResult);
}
