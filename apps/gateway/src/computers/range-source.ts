import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "./store.ts";
import { projectRange } from "./range-projection.ts";
import { compactRangeRecord } from "./range-content.ts";
import { rangeResult } from "./range-effects.ts";
import { prepareRangeClock } from "./range-clock.ts";
import { rangeBatch, rangeRows, type RangeHead, type SealedRecord } from "./range-source-rows.ts";

export type RangeSourceStore = Pick<ComputerStore, "owner" | "runtime" | "query">;

/** The source-commit barrier protects lazy bootstrap and sealing public projections.
 * Source changes + pending journal keys commit together. Sealed payloads never change.
 */
export function readThreadRange(
  store: RangeSourceStore,
  cursor: ui.ThreadSyncCursor,
  through = 0n,
  subscription = "",
  head?: RangeHead,
) {
  return store.runtime
    .runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          // Published records are immutable. During catch-up, reuse the poll's
          // head bound and avoid bootstrap/locking work on sealed replays.
          if (head?.epoch === cursor.epoch && head.seq > cursor.appliedSeq) {
            const end = through > 0n && through < head.seq ? through : head.seq;
            const rows = yield* rangeRows(sql, store.owner, cursor.threadId, head.epoch, cursor.appliedSeq, end);

            if (rows.length && rows.every((row) => row.payload !== null))
              return rangeBatch(cursor, head.seq, end, rows, subscription);
          }

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const clock = yield* prepareRangeClock(sql, store, cursor.threadId);

              const applied = cursor.epoch === clock.epoch ? cursor.appliedSeq : 0n;
              const headSeq = BigInt(clock.head_seq);

              if (applied > headSeq)
                return yield* Effect.fail(new ConnectError("Thread cursor is ahead of its home", Code.OutOfRange));
              const end = through > 0n && through < headSeq ? through : headSeq;

              const rows = yield* rangeRows(sql, store.owner, cursor.threadId, clock.epoch, applied, end);

              const pending = rows.filter((row) => !row.payload);
              const projections = pending.length ? yield* projectRange(cursor.threadId, pending) : [];
              const sealed = new Map<bigint, SealedRecord>();
              const writes: { seq: string; payload: string }[] = [];

              for (const projection of projections) {
                const compact = compactRangeRecord(projection);

                if (compact.content)
                  yield* sql`INSERT INTO thread_replication_content(thread_id,sha256,data)
          VALUES(${cursor.threadId}::uuid,${compact.content.sha256},${compact.content.data}) ON CONFLICT DO NOTHING`;
                sealed.set(projection.seq, { record: compact.record, size: compact.data.length });
                writes.push({
                  seq: projection.seq.toString(),
                  payload: Buffer.from(compact.data.buffer, compact.data.byteOffset, compact.data.byteLength).toString(
                    "base64",
                  ),
                });
              }

              if (writes.length)
                yield* sql`UPDATE thread_replication_journal j SET payload=decode(p.payload,'base64')
        FROM jsonb_to_recordset(${JSON.stringify(writes)}::jsonb) AS p(seq bigint,payload text)
        WHERE j.thread_id=${cursor.threadId}::uuid AND j.epoch=${clock.epoch}::uuid AND j.seq=p.seq AND j.payload IS NULL`;

              return rangeBatch(
                create(ui.ThreadSyncCursorSchema, {
                  threadId: cursor.threadId,
                  epoch: clock.epoch,
                  appliedSeq: applied,
                }),
                headSeq,
                end,
                rows,
                subscription,
                sealed,
              );
            }),
          );
        }),
      ),
    )
    .then(rangeResult);
}
