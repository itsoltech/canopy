import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { applyEnvironment } from "./environment-apply.ts";
import type { Blobs } from "./environment-blobs.ts";
import { WAITING } from "./environment-support.ts";
import type { ConfigRow } from "./persistence.ts";

/**
 * Library records that wait for content or for their marketplace, applied again. Only the local state of a record
 * changes here, so peers see no new revision. True: the library here changed.
 */
export function applyWaitingEnvironment(sql: SqlClient.SqlClient, owner: string, blobs: Blobs = new Map()) {
  return Effect.gen(function* () {
    const hashes = [...blobs.keys()];

    const rows = yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('instruction','skill','marketplace','plugin') AND home_node_id='' AND schema_version=1
      AND (deleted->'value' IS DISTINCT FROM 'true'::jsonb OR fields<>'{}'::jsonb)
      AND (unsupported=${WAITING} OR ${hashes.length > 0} AND (
        kind='marketplace' AND jsonb_typeof(fields#>'{catalog,value,hash}')='string'
          AND jsonb_typeof(fields#>'{catalog,value,commit}')='string'
          AND fields#>>'{catalog,value,hash}'=ANY(${hashes}::text[])
        OR kind<>'marketplace' AND EXISTS (SELECT 1 FROM jsonb_object_keys(fields) AS key
          WHERE length(key)=72 AND starts_with(key,'version.') AND translate(substring(key FROM 9),'0123456789abcdef','')=''
            AND substring(key FROM 9)=ANY(${hashes}::text[]))
      )) ORDER BY CASE kind WHEN 'marketplace' THEN 0 ELSE 1 END,global_id`;

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
