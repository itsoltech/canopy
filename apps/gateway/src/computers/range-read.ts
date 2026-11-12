import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ThreadHistoryQuery } from "../store/thread-window.ts";
import type { ComputerStore } from "./store.ts";
import { qualify } from "./remote.ts";

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
    });

    for (const record of metadata) appendRecord(snapshot, record);
    const before = history?.beforeTurnId?.split("~")[0] ?? "";
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

    for (const record of turns.slice(0, limit).reverse()) appendRecord(snapshot, record);

    const queued = records(
      yield* sql.unsafe<Row>(
        `SELECT payload FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid
    AND epoch=$4::uuid AND kind='turn' AND state='queued' ORDER BY ordinal LIMIT 64`,
        params,
      ),
    );

    for (const record of queued) appendRecord(snapshot, record);
    const ids = snapshot.turns.map((turn) => turn.id);

    const items = records(
      yield* sql.unsafe<Row>(
        `WITH recent AS (SELECT payload,ordinal FROM thread_range_entities WHERE owner_user_id=$1::uuid AND origin_node_id=$2
      AND thread_id=$3::uuid AND epoch=$4::uuid AND kind='item' AND (turn_id=ANY($5::text[]) OR turn_id='')
      ORDER BY ordinal DESC LIMIT 512), bounded AS (SELECT payload,ordinal,sum(octet_length(payload)) OVER(ORDER BY ordinal DESC) AS bytes FROM recent)
    SELECT payload FROM bounded WHERE bytes<=524288 ORDER BY ordinal`,
        [...params, ids],
      ),
    );

    for (const record of items) appendRecord(snapshot, record);
    snapshot.historyBeforeTurnId = snapshot.turns.find((turn) => turn.status !== "queued")?.id ?? "";
    snapshot.lastSeq = snapshot.thread?.lastSeq ?? 0n;
    qualify(ui.ThreadSnapshotSchema, snapshot, node);

    return { snapshot, cursor: snapshot.cursor };
  });
}

export function appendRecord(snapshot: ui.ThreadSnapshot, record: ui.ThreadSyncRecord) {
  const value = record.value;

  switch (value.case) {
    case "thread":
      snapshot.thread = value.value;
      break;
    case "turn":
      snapshot.turns.push(value.value);
      break;
    case "item":
      snapshot.items.push(value.value);
      break;
    case "notice":
      snapshot.notices.push(value.value);
      break;
    case "interaction":
      snapshot.interactions.push(value.value);
      break;
    case "goal":
      snapshot.goal = value.value;
      break;
    case "steer":
      snapshot.steers.push(value.value);
      break;
    case "busDelivery":
      snapshot.busDeliveries.push(value.value);
      break;
  }
}
