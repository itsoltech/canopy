import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ThreadHistoryQuery } from "../store/thread-window.ts";
import type { ComputerStore } from "./store.ts";
import { qualify } from "./remote.ts";
import { appendClientWindow } from "./range-window-records.ts";

export { appendRecord } from "./range-record.ts";

type Row = { payload: Uint8Array };

/** Keyset pages over normalized entities. No full-thread protobuf is loaded or rewritten. */
export async function readRangeMirror(
  store: ComputerStore,
  node: string,
  thread: string,
  history?: ThreadHistoryQuery,
) {
  return store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

          return yield* readRangeWindow(sql, store.owner, node, thread, history);
        }),
      );
    }),
  );
}

function readRangeWindow(
  sql: SqlClient.SqlClient,
  owner: string,
  node: string,
  thread: string,
  history?: ThreadHistoryQuery,
) {
  return Effect.gen(function* () {
    const state = (yield* sql.unsafe<{ epoch: string; applied: string; head: string }>(
      `SELECT visible_epoch AS epoch,visible_applied_seq::text AS applied,head_seq::text AS head FROM thread_range_state
    WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid`,
      [owner, node, thread],
    ))[0];

    if (!state) return undefined;
    const params = [owner, node, thread, state.epoch];
    const records = (rows: readonly Row[]) => rows.map((row) => fromBinary(ui.ThreadSyncRecordSchema, row.payload));

    const metadata = records(
      yield* sql.unsafe<Row>(
        `WITH recent AS (SELECT payload,seq,kind FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2
    AND thread_id=$3::uuid AND epoch=$4::uuid AND kind NOT IN ('turn','item') ORDER BY (kind='thread') DESC,seq DESC LIMIT 256),
    bounded AS (SELECT payload,sum(octet_length(payload)) OVER(ORDER BY (kind='thread') DESC,seq DESC) AS bytes FROM recent)
    SELECT payload FROM bounded WHERE bytes<=131072`,
        params,
      ),
    );

    const snapshot = create(ui.ThreadSnapshotSchema, {
      cursor: `range:${state.epoch}:${state.applied}`,
      historyVersion: state.epoch,
      syncCursor: { threadId: thread, epoch: state.epoch, appliedSeq: BigInt(state.applied) },
      historyReset: !!history?.historyVersion && history.historyVersion !== state.epoch,
    });

    const before = !snapshot.historyReset ? (history?.beforeTurnId?.split("~")[0] ?? "") : "";
    const limit = Math.min(history?.pageSize || 24, 100);

    const turns = records(
      yield* sql.unsafe<Row>(
        `SELECT payload FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid
    AND epoch=$4::uuid AND kind='turn' AND state<>'queued' AND ordinal<coalesce((SELECT ordinal FROM thread_range_entities
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid AND epoch=$4::uuid AND kind='turn' AND turn_id=$5 LIMIT 1),9223372036854775807)
    ORDER BY ordinal DESC,entity_key DESC LIMIT $6`,
        [...params, before, limit + 1],
      ),
    );

    snapshot.historyHasMore = turns.length > limit;

    const queued = records(
      yield* sql.unsafe<Row>(
        `SELECT payload FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid
    AND epoch=$4::uuid AND kind='turn' AND state='queued' ORDER BY ordinal LIMIT 64`,
        params,
      ),
    );

    const beforeItem = !snapshot.historyReset ? (history?.beforeItemId?.split("~")[0] ?? "") : "";
    const itemLimit = Math.min(128, limit * 6);

    const items = records(
      yield* sql.unsafe<Row>(
        `WITH eligible AS (SELECT payload,ordinal,entity_key FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2
      AND thread_id=$3::uuid AND epoch=$4::uuid AND kind='item'), recent AS (
      SELECT * FROM eligible WHERE (ordinal,entity_key)<coalesce((SELECT (ordinal,entity_key) FROM eligible
      WHERE entity_key IN ('item:' || $5,'legacy_item:' || $5) LIMIT 1),ROW(9223372036854775807,''::text))
      ORDER BY ordinal DESC,entity_key DESC LIMIT $6), bounded AS (SELECT payload,ordinal,entity_key,
      sum(octet_length(payload)) OVER(ORDER BY ordinal DESC,entity_key DESC) AS bytes FROM recent)
    SELECT payload FROM bounded WHERE bytes<=393216 ORDER BY ordinal DESC,entity_key DESC`,
        [...params, beforeItem, itemLimit + 1],
      ),
    );

    const oldestItem = items.slice(0, itemLimit).at(-1);
    snapshot.historyItemsHasMore = oldestItem
      ? (yield* sql.unsafe<{ more: boolean }>(
          `SELECT EXISTS(
      SELECT 1 FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid
      AND epoch=$4::uuid AND kind='item' AND (ordinal,entity_key)<($5::bigint,$6)) AS more`,
          [...params, oldestItem.position.toString(), oldestItem.key],
        ))[0]!.more
      : false;

    const missingTurns = items.flatMap((record) =>
      record.value.case === "item" && record.value.value.turnId ? [record.value.value.turnId] : [],
    );

    const supporting = records(
      yield* sql.unsafe<Row>(
        `SELECT payload FROM thread_range_entities
      WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid AND epoch=$4::uuid
      AND kind='turn' AND turn_id=ANY($5::text[]) ORDER BY ordinal`,
        [...params, missingTurns],
      ),
    );

    appendClientWindow(
      snapshot,
      [...metadata, ...turns.slice(0, limit), ...queued, ...items.slice(0, itemLimit), ...supporting],
      turns.slice(0, limit).flatMap((record) => (record.value.case === "turn" ? [record.value.value.id] : [])),
    );
    snapshot.historyBeforeTurnId ||= before;
    snapshot.historyBeforeItemId ||= beforeItem;
    snapshot.lastSeq = snapshot.thread?.lastSeq ?? 0n;
    qualify(ui.ThreadSnapshotSchema, snapshot, node);

    return { snapshot, cursor: snapshot.cursor };
  });
}
