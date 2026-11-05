import { Effect, Predicate } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { alias, type Placement } from "./identity.ts";
import type { ConnectError } from "@connectrpc/connect";
import { canonicalId, recordOf } from "./provider-apply.ts";
import { alive } from "./provider-records.ts";
import { type ConfigRow } from "./persistence.ts";
import { joinProjectRecords, moveProjectChildren } from "./project-rekey.ts";
import { ambiguousProjectOrigin, knownProjectOrigin, UUID } from "./project-values.ts";

function origin(row: ConfigRow) {
  const value = row.fields["origin"]?.value;

  return alive(row) &&
    row.fields["archived"]?.value !== true &&
    Predicate.isString(value) &&
    !ambiguousProjectOrigin(row.fields, value) &&
    UUID.test(row.global_id) &&
    knownProjectOrigin(value)
    ? value
    : "";
}

/** Same known origin, exactly one local candidate. Unknown or ambiguous origins merge only by id. */
export function placeProject(
  sql: SqlClient.SqlClient,
  owner: string,
  incoming: ConfigRow,
): Effect.Effect<Placement, SqlError.SqlError | ConnectError> {
  return Effect.gen(function* () {
    const id =
      incoming.global_id === "account" && incoming.kind === "worktree_policy"
        ? "account"
        : yield* canonicalId(sql, owner, "project", incoming.global_id);

    const item = { ...incoming, global_id: id };
    const current = yield* recordOf(sql, owner, item.kind, id);

    if (item.kind !== "project" || item.schema_version !== 1 || item.home_node_id || !origin(item))
      return { item, current, moved: false };

    const records = yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind='project' AND home_node_id='' AND unsupported='' ORDER BY global_id`;

    if (
      records.some(
        (r) =>
          alive(r) &&
          r.fields["archived"]?.value !== true &&
          r.fields["origin"]?.value === origin(item) &&
          ambiguousProjectOrigin(r.fields, origin(item)),
      )
    )
      return { item, current, moved: false };
    const candidates = records.filter((candidate) => candidate.global_id !== id && origin(candidate) === origin(item));

    if (candidates.length !== 1) return { item, current, moved: false };
    const candidate = candidates[0]!;
    let local = candidate.local_id;

    if (current) {
      const placements = yield* sql<{ project_id: string }>`SELECT DISTINCT project_id::text FROM project_workspaces
        WHERE project_id=ANY(${[current.local_id, candidate.local_id]}::uuid[])`;

      if (placements.length > 1) return { item, current, moved: false };
      local = placements[0]?.project_id ?? current.local_id;
      const redundant = local === current.local_id ? candidate.local_id : current.local_id;
      yield* sql`UPDATE projects SET config_deleted=true,archived_at=COALESCE(archived_at,now())
        WHERE owner_user_id=${owner}::uuid AND id=${redundant}::uuid`;
    }

    if (candidate.global_id < id) {
      yield* alias(sql, owner, "project", id, candidate.global_id);
      const joined = current ? yield* joinProjectRecords(sql, owner, current, candidate.global_id, local) : candidate;
      yield* moveProjectChildren(sql, owner, id, candidate.global_id, local);

      return { item: { ...item, global_id: candidate.global_id }, current: joined, moved: !!current };
    }

    const moved = yield* joinProjectRecords(sql, owner, candidate, id, local);
    yield* moveProjectChildren(sql, owner, candidate.global_id, id, local);

    return { item, current: moved, moved: true };
  });
}
