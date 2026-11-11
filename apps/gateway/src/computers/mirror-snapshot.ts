import { fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** PostgreSQL's protocol parser caps one DataRow at 16 MiB. A durable timeline can be larger.
 * One statement keeps every chunk and the cursor on the same MVCC snapshot. */
export function readMirrorSnapshot(owner: string, node: string, thread: string, generation: string | null = null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{ chunk: Uint8Array; cursor: string }>`
      SELECT substring(t.snapshot FROM part.position FOR 4194304) AS chunk,s.cursor
      FROM computer_mirror_threads t JOIN computer_mirror_state s USING(owner_user_id,origin_node_id)
      CROSS JOIN LATERAL generate_series(1,greatest(octet_length(t.snapshot),1),4194304) AS part(position)
      WHERE t.owner_user_id=${owner}::uuid AND t.origin_node_id=${node} AND t.thread_id=${thread}::uuid
        AND t.generation=coalesce(${generation}::uuid,s.generation) ORDER BY part.position`;

    if (!rows[0]) return undefined;

    return {
      snapshot: fromBinary(ui.ThreadSnapshotSchema, Buffer.concat(rows.map((row) => row.chunk))),
      cursor: rows[0].cursor,
    };
  });
}
