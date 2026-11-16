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
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import { contentHash, leaseRangeRecords, retainCurrentContent } from "./range-leases.ts";
import { replaySealedRange } from "./range-replay.ts";

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

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const replay = yield* replaySealedRange(sql, store, cursor, through, subscription, head);

              if (replay) return replay;

              let clock = yield* prepareRangeClock(sql, store, cursor.threadId);

              // The retained suffix is a separate contract from a missing row
              // within it. Expired cursors rebuild through the normal epoch path.
              if (
                BigInt(clock.replay_floor_seq) > 0n &&
                (cursor.epoch !== clock.epoch || cursor.appliedSeq < BigInt(clock.replay_floor_seq))
              ) {
                yield* sql`UPDATE thread_replication_clock SET epoch=gen_random_uuid(),head_seq=0,
                  change_version=change_version+1 WHERE thread_id=${cursor.threadId}::uuid`;
                yield* sql`SELECT thread_replication_seed(${cursor.threadId}::uuid)`;
                clock = yield* prepareRangeClock(sql, store, cursor.threadId);
              }

              const applied = cursor.epoch === clock.epoch ? cursor.appliedSeq : 0n;
              const headSeq = BigInt(clock.head_seq);

              if (applied > headSeq)
                return yield* Effect.fail(new ConnectError("Thread cursor is ahead of its home", Code.OutOfRange));
              const limit = head?.epoch === clock.epoch && head.seq < headSeq ? head.seq : headSeq;
              const end = through > 0n && through < limit ? through : limit;

              const rows = yield* rangeRows(sql, store.owner, cursor.threadId, clock.epoch, applied, end);

              const pending = rows.filter((row) => !row.payload);
              const projections = pending.length ? yield* projectRange(cursor.threadId, pending) : [];
              const sealed = new Map<bigint, SealedRecord>();
              const writes: { seq: string; payload: string; hash: string | null }[] = [];

              for (const projection of projections) {
                const compact = compactRangeRecord(projection);

                if (compact.content)
                  yield* sql`INSERT INTO thread_replication_content(thread_id,sha256,data)
          VALUES(${cursor.threadId}::uuid,${compact.content.sha256},${compact.content.data}) ON CONFLICT DO NOTHING`;
                sealed.set(projection.seq, { record: compact.record, size: compact.data.length });
                writes.push({
                  seq: projection.seq.toString(),
                  hash: contentHash(compact.record) ?? null,
                  payload: Buffer.from(compact.data.buffer, compact.data.byteOffset, compact.data.byteLength).toString(
                    "base64",
                  ),
                });
              }

              if (writes.length)
                yield* sql`UPDATE thread_replication_journal j SET payload=decode(p.payload,'base64'),content_sha256=p.hash,content_indexed=true
        FROM jsonb_to_recordset(${JSON.stringify(writes)}::jsonb) AS p(seq bigint,payload text,hash text)
        WHERE j.thread_id=${cursor.threadId}::uuid AND j.epoch=${clock.epoch}::uuid AND j.seq=p.seq AND j.payload IS NULL`;

              const batch = rangeBatch(
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

              yield* retainCurrentContent(
                sql,
                cursor.threadId,
                batch.records.filter((record) => sealed.has(record.seq)),
              );

              yield* leaseRangeRecords(
                sql,
                cursor.threadId,
                clock.epoch,
                headSeq,
                applied,
                batch.records,
                subscription || crypto.randomUUID(),
              );

              return batch;
            }),
          );
        }),
      ).pipe(queryFamily("mirrors.read"), queryRpc),
    )
    .then(rangeResult);
}
