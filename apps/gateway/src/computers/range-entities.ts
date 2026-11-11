import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** At most one bounded batch crosses SQL, instead of a query for every record. */
export function writeRangeEntities(sql: SqlClient.SqlClient, owner: string, node: string, batch: ui.ThreadSyncBatch) {
  return Effect.gen(function* () {
    // Several immutable revisions of one entity can share a batch. Apply its
    // last revision once, including a final tombstone, before advancing the cursor.
    const latest = [...new Map(batch.records.map((record) => [record.key, record])).values()];
    const removed = latest.flatMap((record) => (record.removed ? [record.key] : []));

    if (removed.length)
      yield* sql`DELETE FROM thread_range_entities WHERE owner_user_id=${owner}::uuid
      AND origin_node_id=${node} AND thread_id=${batch.threadId}::uuid AND epoch=${batch.epoch}::uuid
      AND entity_key=ANY(${removed}::text[])`;

    const rows = latest.flatMap((record) => {
      if (record.removed) return [];
      const value = record.value;
      let turnId = "";

      if (value.case === "item") turnId = value.value.turnId;

      if (value.case === "turn") turnId = value.value.id;

      return [
        {
          key: record.key,
          seq: record.seq.toString(),
          kind: value.case ?? "unknown",
          turn_id: turnId,
          ordinal: record.position.toString(),
          state: value.case === "turn" ? value.value.status : "",
          payload: Buffer.from(toBinary(ui.ThreadSyncRecordSchema, record)).toString("base64"),
        },
      ];
    });

    if (rows.length)
      yield* sql`INSERT INTO thread_range_entities
      (owner_user_id,origin_node_id,thread_id,epoch,entity_key,seq,kind,turn_id,ordinal,state,payload)
      SELECT ${owner}::uuid,${node},${batch.threadId}::uuid,${batch.epoch}::uuid,p.key,p.seq,p.kind,p.turn_id,p.ordinal,p.state,decode(p.payload,'base64')
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS p(key text,seq bigint,kind text,turn_id text,ordinal bigint,state text,payload text)
      ON CONFLICT(owner_user_id,origin_node_id,thread_id,epoch,entity_key) DO UPDATE SET seq=excluded.seq,
        kind=excluded.kind,turn_id=excluded.turn_id,ordinal=excluded.ordinal,state=excluded.state,payload=excluded.payload`;
  });
}

export function writeRangeHeader(
  sql: SqlClient.SqlClient,
  owner: string,
  node: string,
  generation: string,
  batch: ui.ThreadSyncBatch,
) {
  return Effect.gen(function* () {
    const header = (yield* sql<{ payload: Uint8Array }>`SELECT payload FROM thread_range_entities
      WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node} AND thread_id=${batch.threadId}::uuid
        AND epoch=${batch.epoch}::uuid AND kind='thread' LIMIT 1`)[0];

    const value = header && fromBinary(ui.ThreadSyncRecordSchema, header.payload).value;

    if (value?.case !== "thread") return;
    yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
      VALUES(${owner}::uuid,${node},${generation}::uuid,${batch.threadId}::uuid,
        ${toBinary(ui.ThreadSnapshotSchema, create(ui.ThreadSnapshotSchema, { thread: value.value }))},${toBinary(ui.ThreadSchema, value.value)})
      ON CONFLICT(owner_user_id,origin_node_id,generation,thread_id)
        DO UPDATE SET thread_metadata=excluded.thread_metadata,snapshot=excluded.snapshot`;
  });
}
