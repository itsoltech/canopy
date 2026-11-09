import type { SqlClient } from "effect/sql";
import type { NewItem } from "./store.ts";
import { jsonBatches } from "./json-batches.ts";

function* rows(items: readonly NewItem[]) {
  for (const [position, item] of items.entries()) {
    yield {
      id: Bun.randomUUIDv7(),
      position,
      agent_cli: item.agentCli,
      root_id: item.rootId,
      native_id: item.nativeId,
      source_key: item.sourceKey,
      title: item.title,
      cwd: item.cwd,
      snapshot: item.snapshot,
      target: item.target,
      bytes_total: item.bytes.toString(),
    };
  }
}

/** Fresh imports share the existing run lock and transaction. Appends retain their per-thread validation path. */
export function insertFreshItems(
  sql: SqlClient.SqlClient,
  run: { id: string; ownerId: string; workerId: string },
  items: readonly NewItem[],
) {
  return jsonBatches(
    rows(items),
    (json) => sql`INSERT INTO import_items
    (id,run_id,owner_user_id,worker_id,position,agent_cli,root_id,native_id,source_key,title,cwd,snapshot,target,status,bytes_total)
    SELECT x.id,${run.id}::uuid,${run.ownerId}::uuid,${run.workerId}::uuid,x.position,x.agent_cli,x.root_id,x.native_id,
      x.source_key,x.title,x.cwd,x.snapshot,x.target,'pending',x.bytes_total
    FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid,position integer,agent_cli text,root_id text,native_id text,
      source_key text,title text,cwd text,snapshot jsonb,target jsonb,bytes_total bigint)`,
  );
}
