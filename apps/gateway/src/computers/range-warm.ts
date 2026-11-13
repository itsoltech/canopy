import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { packThreadBatch } from "@canopy/domain/thread-sync";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { readRangeWindow } from "./range-read.ts";
import { qualify } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

/** Read the advertised local checkpoint, without opening a connection to the home. */
export function warmRangeMirror(store: ComputerStore, node: string, input: ui.WatchThreadRequest) {
  if (input.syncCursor && input.syncCursor.threadId !== input.threadId)
    throw new ConnectError("Thread cursor identity mismatch", Code.InvalidArgument);

  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
          const thread = splitId(input.threadId).id;

          const state = (yield* sql<{ epoch: string; applied: string }>`
            SELECT s.visible_epoch::text AS epoch,s.visible_applied_seq::text AS applied
            FROM thread_range_state s JOIN computer_peers p
              ON p.owner_user_id=s.owner_user_id AND p.node_id=s.origin_node_id
            WHERE s.owner_user_id=${store.owner}::uuid AND s.origin_node_id=${node}
              AND s.thread_id=${thread}::uuid AND (p.via_node_id IS NULL OR p.relay_role IN ('home','both'))`)[0];

          if (!state) return undefined;
          const head = BigInt(state.applied);
          let cursor = input.syncCursor;

          const rows =
            cursor && cursor.epoch === state.epoch && cursor.appliedSeq <= head && head - cursor.appliedSeq <= 256n
              ? yield* sql<{ seq: string; payload: Uint8Array }>`SELECT seq::text,payload
                FROM thread_mirror_recent_ranges WHERE owner_user_id=${store.owner}::uuid AND origin_node_id=${node}
                AND thread_id=${thread}::uuid AND epoch=${state.epoch}::uuid
                AND seq>${cursor.appliedSeq} AND seq<=${head} ORDER BY seq LIMIT 256`
              : [];

          // Upgrades, retention and epoch changes can remove a suffix. Reset only
          // to the existing bounded/pageable window; never reconstruct full history.
          if (
            !cursor ||
            cursor.epoch !== state.epoch ||
            cursor.appliedSeq > head ||
            BigInt(rows.length) !== head - cursor.appliedSeq
          ) {
            const held = yield* readRangeWindow(sql, store.owner, node, thread, {
              ...create(ui.WatchThreadRequestSchema, { pageSize: 24 }),
              bounded: true,
            });

            return held
              ? [create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: held.snapshot } })]
              : undefined;
          }

          const records = rows.map((row) => {
            const record = fromBinary(ui.ThreadSyncRecordSchema, row.payload);
            qualify(ui.ThreadSyncRecordSchema, record, node);

            return record;
          });

          const updates: ui.ThreadUpdate[] = [];
          let offset = 0;

          // Qualify before packing so expanded IDs still respect the wire bound.
          for (let count = 0; count < 4; count++) {
            const batch = packThreadBatch(cursor, head, records.slice(offset));
            updates.push(create(ui.ThreadUpdateSchema, { change: { case: "batch", value: batch } }));
            cursor = create(ui.ThreadSyncCursorSchema, {
              threadId: batch.threadId,
              epoch: batch.epoch,
              appliedSeq: batch.appliedSeq,
            });
            offset += batch.records.length;

            if (batch.caughtUp) break;
          }

          return updates;
        }),
      );
    }),
  );
}
