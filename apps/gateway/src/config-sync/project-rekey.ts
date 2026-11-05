import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { alias, rekey } from "./identity.ts";
import { clockParts } from "./clock.ts";
import { mergeRecord } from "./merge.ts";
import { recordOf } from "./provider-apply.ts";
import { saveRecord, type ConfigRow } from "./persistence.ts";

/** A late origin can join an existing replica. Domain rows with local placements are never rekeyed. */
export function joinProjectRecords(
  sql: SqlClient.SqlClient,
  owner: string,
  from: ConfigRow,
  to: string,
  local: string,
) {
  return Effect.gen(function* () {
    const target = yield* recordOf(sql, owner, from.kind, to);
    const clock = (yield* sql<{ hlc: string }>`SELECT hlc FROM config_clock WHERE owner_user_id=${owner}::uuid`)[0]!;
    let result: ConfigRow;

    if (target) {
      result = (yield* mergeRecord(
        sql,
        owner,
        target,
        { ...from, global_id: to },
        clockParts(from.fields["origin"]?.hlc ?? "").node,
      )).row;
      yield* sql`DELETE FROM config_items WHERE owner_user_id=${owner}::uuid AND kind=${from.kind} AND global_id=${from.global_id}`;
      yield* sql`DELETE FROM config_history a USING config_history b WHERE a.owner_user_id=${owner}::uuid
        AND b.owner_user_id=a.owner_user_id AND a.kind=${from.kind} AND b.kind=a.kind
        AND a.global_id=${from.global_id} AND b.global_id=${to} AND a.field=b.field AND a.hlc=b.hlc`;
      yield* sql`UPDATE config_history SET global_id=${to} WHERE owner_user_id=${owner}::uuid AND kind=${from.kind} AND global_id=${from.global_id}`;
      yield* sql`UPDATE config_aliases SET global_id=${to} WHERE owner_user_id=${owner}::uuid AND kind=${from.kind} AND global_id=${from.global_id}`;
    } else result = yield* rekey(sql, owner, from, to);
    result.local_id = local;
    yield* alias(sql, owner, from.kind, from.global_id, to);
    yield* saveRecord(sql, owner, result, clock.hlc);

    return result;
  });
}

export function moveProjectChildren(sql: SqlClient.SqlClient, owner: string, from: string, to: string, local: string) {
  return Effect.gen(function* () {
    const children = yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('project_settings','worktree_policy') AND global_id=${from}`;

    for (const child of children) yield* joinProjectRecords(sql, owner, child, to, local);
  });
}
