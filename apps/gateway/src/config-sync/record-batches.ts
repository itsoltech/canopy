import type { SqlClient } from "effect/sql";
import { jsonBatches } from "../json-batches.ts";
import type { ConfigRow } from "./persistence.ts";

function* values(rows: Iterable<ConfigRow>) {
  for (const row of rows)
    yield {
      kind: row.kind,
      global_id: row.global_id,
      local_id: row.local_id,
      home_node_id: row.home_node_id,
      identity: row.identity,
      fields: row.fields,
      deleted: row.deleted,
      schema_version: row.schema_version,
      unsupported: row.unsupported,
    };
}

/** The caller holds the owner's clock lock and transaction; allocate exact bigint revisions per bounded batch. */
export function saveRecords(sql: SqlClient.SqlClient, owner: string, rows: Iterable<ConfigRow>, hlc: string) {
  return jsonBatches(
    values(rows),
    (json) => sql`
      WITH input AS MATERIALIZED (
        SELECT r.position,v.* FROM jsonb_array_elements(${json}::jsonb) WITH ORDINALITY r(value,position)
        CROSS JOIN LATERAL jsonb_to_record(r.value) AS v(kind text,global_id text,local_id text,home_node_id text,
          identity text,fields jsonb,deleted jsonb,schema_version integer,unsupported text)
      ), clock AS (
        UPDATE config_clock SET revision=revision+(SELECT count(*) FROM input),hlc=${hlc}
        WHERE owner_user_id=${owner}::uuid RETURNING revision
      )
      INSERT INTO config_items(owner_user_id,kind,global_id,local_id,home_node_id,identity,fields,deleted,revision,schema_version,unsupported)
      SELECT ${owner}::uuid,kind,global_id,local_id,home_node_id,identity,fields,deleted,
        (SELECT revision FROM clock)-(SELECT count(*) FROM input)+position,schema_version,unsupported FROM input
      ON CONFLICT(owner_user_id,kind,global_id) DO UPDATE SET local_id=excluded.local_id,identity=excluded.identity,
        fields=excluded.fields,deleted=excluded.deleted,revision=excluded.revision,
        schema_version=excluded.schema_version,unsupported=excluded.unsupported`,
  );
}
