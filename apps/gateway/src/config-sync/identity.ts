import { Effect, Predicate } from "effect";
import { type SqlClient, type SqlError } from "effect/sql";
import { clockParts, compareClock } from "./clock.ts";
import type { ConfigRow } from "./persistence.ts";
import { canonicalId, recordOf } from "./provider-apply.ts";
import { alive } from "./provider-records.ts";
import { instanceIdentity, PROVIDER_KINDS, proxyIdentity, valuesOf } from "./provider-values.ts";
import { currentSecret } from "./secrets.ts";

/**
 * Where a received record belongs here (docs/linked-computers.md, "Bootstrap i scalanie tożsamości"). Every
 * computer decides alone and reaches the same result: an alias names the canonical (smaller) id; an element with
 * the same identity and key becomes one element; an unrelated element with the same instance id gets its own id.
 */

type Key = { identity: string; secret: string | undefined };

export type Placement = { item: ConfigRow; current: ConfigRow | undefined; moved: boolean; republish?: ConfigRow };

function keyOf(
  sql: SqlClient.SqlClient,
  owner: string,
  key: Buffer,
  row: ConfigRow,
  plain?: ReadonlyMap<string, string>,
) {
  return Effect.gen(function* () {
    const values = valuesOf(row.fields);

    const secretOf = (target: ConfigRow, name: string, own?: ReadonlyMap<string, string>) =>
      own?.has(name)
        ? Effect.succeed(own.get(name))
        : Effect.map(currentSecret(sql, owner, key, target, name), (found) => found?.plain);

    if (row.kind === "proxy")
      return {
        identity: proxyIdentity(values),
        secret: values["secret"] ? yield* secretOf(row, "secret", plain) : undefined,
      };

    const [harness] = row.global_id.split(":");
    const proxyId = Predicate.isString(values["proxy"]) ? values["proxy"] : "";

    const proxy = proxyId
      ? yield* recordOf(sql, owner, "proxy", yield* canonicalId(sql, owner, "proxy", proxyId))
      : undefined;

    if (proxyId && !proxy) return { identity: "", secret: undefined };
    const endpoint = proxy ? String(proxy.fields["baseUrl"]?.value ?? "") : String(values["baseUrl"] ?? "");
    const builtIn = row.global_id.endsWith(":native");

    const secret = proxy
      ? proxy.fields["secret"]?.value
        ? yield* secretOf(proxy, "secret")
        : undefined
      : values["apiKey"]
        ? yield* secretOf(row, "apiKey", plain)
        : undefined;

    return { identity: instanceIdentity(harness ?? "", values, endpoint, builtIn), secret };
  });
}

const sameKey = (a: Key, b: Key) => !!a.identity && a.identity === b.identity && a.secret === b.secret;

/** Records that never shared a version were created apart. */
function unrelated(a: ConfigRow, b: ConfigRow) {
  const names = Object.keys(a.fields).filter((n) => b.fields[n]);

  if (!names.length || !alive(a) || !alive(b)) return false;

  return names.every((n) => {
    const x = a.fields[n]!;
    const y = b.fields[n]!;

    return x.hlc !== y.hlc && x.prev !== y.hlc && y.prev !== x.hlc;
  });
}

const firstClock = (row: ConfigRow) =>
  Object.values(row.fields).reduce((min, f) => (!min || compareClock(f.hlc, min) < 0 ? f.hlc : min), "");

/** Moves a local record, its secrets and history to another global id; aliases follow. */
function rekey(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, id: string) {
  return Effect.gen(function* () {
    for (const table of ["config_items", "config_secrets", "config_history"])
      yield* sql.unsafe(`UPDATE ${table} SET global_id=$4 WHERE owner_user_id=$1::uuid AND kind=$2 AND global_id=$3`, [
        owner,
        row.kind,
        row.global_id,
        id,
      ]);
    yield* sql`UPDATE config_aliases SET global_id=${id} WHERE owner_user_id=${owner}::uuid AND kind=${row.kind}
      AND global_id=${row.global_id}`;

    return { ...row, global_id: id };
  });
}

function alias(sql: SqlClient.SqlClient, owner: string, kind: string, from: string, to: string) {
  return sql`INSERT INTO config_aliases(owner_user_id,kind,alias_id,global_id) VALUES(${owner}::uuid,${kind},${from},${to})
    ON CONFLICT(owner_user_id,kind,alias_id) DO UPDATE SET global_id=excluded.global_id`;
}

/**
 * The incoming record's id here and the local record it merges into. `moved`: that local record changed id;
 * `republish`: another local record changed id. Both need a new revision so peers learn the new id.
 */
export function place(
  sql: SqlClient.SqlClient,
  owner: string,
  key: Buffer,
  incoming: ConfigRow,
  plain: ReadonlyMap<string, string>,
): Effect.Effect<Placement, SqlError.SqlError> {
  return Effect.gen(function* () {
    const item = { ...incoming, global_id: yield* canonicalId(sql, owner, incoming.kind, incoming.global_id) };
    let current = yield* recordOf(sql, owner, item.kind, item.global_id);

    if (!PROVIDER_KINDS.has(item.kind) || item.home_node_id) return { item, current, moved: false };
    const theirs = yield* keyOf(sql, owner, key, item, plain);

    if (current) {
      if (item.kind !== "instance" || item.global_id.endsWith(":native") || !unrelated(current, item))
        return { item, current, moved: false };
      const ours = yield* keyOf(sql, owner, key, current);

      // Without an identity on both sides there is nothing to tell them apart: one element, merged per field.
      if (!ours.identity || !theirs.identity || sameKey(ours, theirs)) return { item, current, moved: false };

      // The same instance id for two different elements: the later one gets a stable id of its own.
      const later = [current, item].sort((a, b) => compareClock(firstClock(a), firstClock(b)))[1]!;
      const id = `${item.global_id}-${clockParts(firstClock(later)).node.slice(0, 8)}`;

      if (later === item)
        return { item: { ...item, global_id: id }, current: yield* recordOf(sql, owner, item.kind, id), moved: false };

      // Republished under its new id; peers reach the same split from the same two records.
      return { item, current: undefined, moved: false, republish: yield* rekey(sql, owner, current, id) };
    }

    if (!theirs.identity) return { item, current, moved: false };

    const candidates = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind=${item.kind} AND home_node_id='' AND unsupported='' ORDER BY global_id`).filter(alive);

    for (const candidate of candidates) {
      if (!sameKey(yield* keyOf(sql, owner, key, candidate), theirs)) continue;

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
