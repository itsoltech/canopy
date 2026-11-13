import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** Preserve immutable revisions and tombstones independently of the latest-entity projection. */
export function writeRecentRange(sql: SqlClient.SqlClient, owner: string, node: string, batch: ui.ThreadSyncBatch) {
  return Effect.gen(function* () {
    const rows = batch.records.map((record) => ({
      seq: record.seq.toString(),
      payload: Buffer.from(toBinary(ui.ThreadSyncRecordSchema, record)).toString("base64"),
    }));

    if (rows.length)
      yield* sql`INSERT INTO thread_mirror_recent_ranges(owner_user_id,origin_node_id,thread_id,epoch,seq,payload)
        SELECT ${owner}::uuid,${node},${batch.threadId}::uuid,${batch.epoch}::uuid,p.seq,decode(p.payload,'base64')
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS p(seq bigint,payload text)
        ON CONFLICT DO NOTHING`;

    // At most 256 records / 256 KiB per retained epoch. Keep the previous visible
    // epoch during a rebuild, just like the normalized entity projection.
    yield* sql`WITH retained AS (
      SELECT epoch,seq,row_number() OVER(PARTITION BY epoch ORDER BY seq DESC) AS count,
        sum(octet_length(payload)) OVER(PARTITION BY epoch ORDER BY seq DESC) AS bytes
      FROM thread_mirror_recent_ranges WHERE owner_user_id=${owner}::uuid AND origin_node_id=${node}
        AND thread_id=${batch.threadId}::uuid
    ) DELETE FROM thread_mirror_recent_ranges r USING retained p,thread_range_state s
      WHERE r.owner_user_id=${owner}::uuid AND r.origin_node_id=${node} AND r.thread_id=${batch.threadId}::uuid
        AND r.epoch=p.epoch AND r.seq=p.seq AND s.owner_user_id=r.owner_user_id
        AND s.origin_node_id=r.origin_node_id AND s.thread_id=r.thread_id
        AND (p.count>256 OR p.bytes>262144 OR (r.epoch<>s.epoch AND r.epoch<>s.visible_epoch))`;
  });
}
