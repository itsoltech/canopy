import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import type { ConnectError } from "@connectrpc/connect";
import { alias, rekey, type Placement } from "./identity.ts";
import { connectorIdentity } from "./connector-values.ts";
import type { ConfigRow } from "./persistence.ts";
import { canonicalId, recordOf } from "./provider-apply.ts";
import { alive } from "./provider-records.ts";
import { valuesOf } from "./provider-values.ts";
import { currentSecret } from "./secrets.ts";
import { sharedCredentials } from "../connectors/credential-values.ts";

function headerIdentity(plain: string | undefined) {
  if (!plain) return undefined;

  try {
    const headers = sharedCredentials(plain).headers ?? {};

    return JSON.stringify(
      Object.entries(headers)
        .map(([k, v]) => [k.toLowerCase(), v] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  } catch {
    return undefined;
  }
}

/** Merge a single matching account. Ambiguous name fallbacks keep separate accounts and their ids. */
export function placeConnector(
  sql: SqlClient.SqlClient,
  owner: string,
  key: Buffer,
  incoming: ConfigRow,
  plain: ReadonlyMap<string, string>,
): Effect.Effect<Placement, SqlError.SqlError | ConnectError> {
  return Effect.gen(function* () {
    const item = { ...incoming, global_id: yield* canonicalId(sql, owner, incoming.kind, incoming.global_id) };
    const current = yield* recordOf(sql, owner, item.kind, item.global_id);

    if (current || item.home_node_id || item.schema_version !== 1 || !alive(item))
      return { item, current, moved: false };
    const identity = connectorIdentity(item.kind, valuesOf(item.fields));

    if (!identity) return { item, current, moved: false };

    const candidates = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind=${item.kind} AND home_node_id='' AND unsupported='' ORDER BY global_id`).filter(
      (r) => alive(r) && connectorIdentity(r.kind, valuesOf(r.fields)) === identity,
    );

    if (candidates.length !== 1) return { item, current, moved: false };
    const candidate = candidates[0]!;

    // A name cannot identify two different header-auth accounts at the same endpoint.
    if (
      item.kind === "connector" &&
      (item.fields["authKind"]?.value === "headers" || candidate.fields["authKind"]?.value === "headers")
    ) {
      const theirs = headerIdentity(plain.get("credentials"));
      const ours = headerIdentity((yield* currentSecret(sql, owner, key, candidate, "credentials"))?.plain);

      if (item.fields["authKind"]?.value !== candidate.fields["authKind"]?.value || !theirs || ours !== theirs)
        return { item, current, moved: false };
    }

    if (candidate.global_id < item.global_id) {
      yield* alias(sql, owner, item.kind, item.global_id, candidate.global_id);

      return { item: { ...item, global_id: candidate.global_id }, current: candidate, moved: false };
    }

    const moved = yield* rekey(sql, owner, candidate, item.global_id);
    yield* alias(sql, owner, item.kind, candidate.global_id, item.global_id);

    return { item, current: moved, moved: true };
  });
}
