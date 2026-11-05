import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { applyEnvironment } from "./environment-apply.ts";
import { namesAny, type Blobs } from "./environment-blobs.ts";
import { WAITING } from "./environment-support.ts";
import type { ConfigRow } from "./persistence.ts";
import { alive } from "./provider-records.ts";

/**
 * Library records that wait for content or for their marketplace, applied again. Only the local state of a record
 * changes here, so peers see no new revision. True: the library here changed.
 */
export function applyWaitingEnvironment(sql: SqlClient.SqlClient, owner: string, blobs: Blobs = new Map()) {
  return Effect.gen(function* () {
    const hashes = new Set(blobs.keys());

    const rows = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('instruction','skill','marketplace','plugin') AND home_node_id='' AND schema_version=1
      ORDER BY CASE kind WHEN 'marketplace' THEN 0 ELSE 1 END,global_id`).filter(
      (r) => alive(r) && (r.unsupported === WAITING || namesAny(r, hashes)),
    );

    let changed = false;

    for (const row of rows) {
      const before = row.unsupported;
      row.unsupported = "";
      changed = (yield* applyEnvironment(sql, owner, row, blobs)) || changed;

      if (row.unsupported !== before)
        yield* sql`UPDATE config_items SET unsupported=${row.unsupported} WHERE owner_user_id=${owner}::uuid
          AND kind=${row.kind} AND global_id=${row.global_id}`;
    }

    return changed;
  });
}
