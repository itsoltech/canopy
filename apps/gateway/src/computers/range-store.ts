import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ThreadSyncGap, validateThreadBatch } from "@canopy/domain/thread-sync";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "./store.ts";
import { rangeResult } from "./range-effects.ts";
import { writeRangeEntities, writeRangeHeader } from "./range-entities.ts";
import { writeRecentRange } from "./range-recent.ts";

type Saved = {
  epoch: string;
  visible_epoch: string;
  applied_seq: string;
  head_seq: string;
  visible_applied_seq: string;
};

export class ThreadRangeStore {
  constructor(readonly store: ComputerStore) {}

  async cursors(node: string) {
    const rows = await this.store.query<Saved & { thread_id: string }>(
      `SELECT thread_id,epoch,applied_seq::text,head_seq::text,visible_epoch,visible_applied_seq::text FROM thread_range_state
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 ORDER BY thread_id`,
      [this.store.owner, node],
    );

    return rows.map((row) =>
      create(ui.ThreadSyncCursorSchema, {
        threadId: row.thread_id,
        epoch: row.epoch,
        appliedSeq: BigInt(row.applied_seq),
      }),
    );
  }

  /** Fence older consumers before reading their checkpoints. Unlink cannot recreate a mirror. */
  async begin(node: string) {
    const rows = await this.store.query<{ subscription_id: string }>(
      `INSERT INTO computer_mirror_state(owner_user_id,origin_node_id,subscription_id)
      SELECT $1::uuid,$2,gen_random_uuid() WHERE EXISTS(SELECT 1 FROM computer_peers
        WHERE owner_user_id=$1::uuid AND node_id=$2 AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR SHARE)
      ON CONFLICT(owner_user_id,origin_node_id) DO UPDATE SET subscription_id=excluded.subscription_id
      RETURNING subscription_id`,
      [this.store.owner, node],
    );

    if (!rows[0]) throw new ConnectError("Thread mirror is no longer authorized", Code.PermissionDenied);

    return rows[0].subscription_id;
  }

  apply(node: string, subscription: string, batch: ui.ThreadSyncBatch) {
    const { owner, runtime } = this.store;

    return runtime
      .runPromise(
        Effect.exit(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const fenced = yield* sql<{ generation: string }>`SELECT generation FROM computer_mirror_state
          WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND subscription_id=${subscription}::uuid FOR UPDATE`;

                if (!fenced[0])
                  return yield* Effect.fail(new ConnectError("Thread subscription superseded", Code.Aborted));

                const saved =
                  (yield* sql<Saved>`SELECT epoch,visible_epoch,applied_seq::text,head_seq::text,visible_applied_seq::text FROM thread_range_state
          WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND thread_id=${batch.threadId}::uuid FOR UPDATE`)[0];

                const applied = saved?.epoch === batch.epoch ? BigInt(saved.applied_seq) : 0n;

                if (saved?.epoch === batch.epoch && applied >= batch.appliedSeq) {
                  validateThreadBatch(batch, batch.baseSeq);

                  return create(ui.ThreadSyncCursorSchema, {
                    threadId: batch.threadId,
                    epoch: batch.epoch,
                    appliedSeq: applied,
                  });
                }

                if (batch.baseSeq !== applied) return yield* Effect.fail(new ThreadSyncGap(applied));
                validateThreadBatch(batch, applied);
                const visible = !saved || batch.caughtUp ? batch.epoch : saved.visible_epoch;
                const visibleSeq = visible === batch.epoch ? batch.appliedSeq : BigInt(saved?.visible_applied_seq ?? 0);
                yield* sql`INSERT INTO thread_range_state(owner_user_id,origin_node_id,thread_id,epoch,visible_epoch,
            applied_seq,head_seq,visible_applied_seq,subscription_id,last_synced_at)
          VALUES(${owner}::uuid,${node},${batch.threadId}::uuid,${batch.epoch}::uuid,${visible}::uuid,
            ${batch.appliedSeq},${batch.headSeq},${visibleSeq},${subscription}::uuid,CURRENT_TIMESTAMP)
          ON CONFLICT(owner_user_id,origin_node_id,thread_id) DO UPDATE SET epoch=excluded.epoch,
            visible_epoch=excluded.visible_epoch,applied_seq=excluded.applied_seq,head_seq=excluded.head_seq,
            visible_applied_seq=excluded.visible_applied_seq,subscription_id=excluded.subscription_id,
            last_synced_at=excluded.last_synced_at`;
                yield* writeRangeEntities(sql, owner, node, batch);
                yield* writeRecentRange(sql, owner, node, batch);

                if (batch.caughtUp)
                  yield* sql`DELETE FROM thread_range_entities WHERE owner_user_id=${owner}::uuid
          AND origin_node_id=${node} AND thread_id=${batch.threadId}::uuid AND epoch<>${batch.epoch}::uuid`;

                if (
                  visible === batch.epoch &&
                  (batch.caughtUp || batch.records.some((record) => record.value.case === "thread"))
                )
                  yield* writeRangeHeader(sql, owner, node, fenced[0].generation, batch);
                yield* sql`UPDATE computer_mirror_state SET cursor=${`range:${batch.epoch}:${batch.appliedSeq}`}
          WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}`;

                return create(ui.ThreadSyncCursorSchema, {
                  threadId: batch.threadId,
                  epoch: batch.epoch,
                  appliedSeq: batch.appliedSeq,
                });
              }),
            );
          }),
        ),
      )
      .then(rangeResult);
  }
}
