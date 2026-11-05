import { Effect, Predicate } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { ConnectError } from "@connectrpc/connect";
import { alias, rekey, type Placement } from "./identity.ts";
import type { ConfigRow } from "./persistence.ts";
import { canonicalId, recordOf } from "./provider-apply.ts";
import { alive } from "./provider-records.ts";
import { valuesOf } from "./provider-values.ts";
import { environmentIdentity } from "./environment-values.ts";

function identityOf(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  return Effect.gen(function* () {
    const values = valuesOf(row.fields);
    const market = values["marketplace"];

    const marketplace =
      row.kind === "plugin" && Predicate.isString(market) ? yield* canonicalId(sql, owner, "marketplace", market) : "";

    return environmentIdentity(row.kind, values, marketplace);
  });
}

/**
 * An element made apart on two computers with the same identity becomes one: the smaller id is canonical and the
 * other an alias. Both local rows stay; different content becomes another version of the one element.
 */
export function placeEnvironment(
  sql: SqlClient.SqlClient,
  owner: string,
  incoming: ConfigRow,
): Effect.Effect<Placement, SqlError.SqlError | ConnectError> {
  return Effect.gen(function* () {
    const item = { ...incoming, global_id: yield* canonicalId(sql, owner, incoming.kind, incoming.global_id) };
    let current = yield* recordOf(sql, owner, item.kind, item.global_id);

    if (current || item.home_node_id || item.schema_version !== 1 || !alive(item))
      return { item, current, moved: false };
    const identity = yield* identityOf(sql, owner, item);

    if (!identity) return { item, current, moved: false };

    const candidates = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind=${item.kind} AND home_node_id='' AND unsupported='' ORDER BY global_id`).filter(alive);

    for (const candidate of candidates) {
      if ((yield* identityOf(sql, owner, candidate)) !== identity) continue;

      if (candidate.global_id < item.global_id) {
        yield* alias(sql, owner, item.kind, item.global_id, candidate.global_id);

        return { item: { ...item, global_id: candidate.global_id }, current: candidate, moved: false };
      }

      current = yield* rekey(sql, owner, candidate, item.global_id);
      yield* alias(sql, owner, item.kind, candidate.global_id, item.global_id);

      return { item, current, moved: true };
    }

    return { item, current, moved: false };
  });
}
