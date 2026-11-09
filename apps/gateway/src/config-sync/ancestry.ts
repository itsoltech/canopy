import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { clockParts, compareClock } from "./clock.ts";
import type { ConfigRow, Field } from "./persistence.ts";

export type Ancestry = { prev: string; seen: string[] };

/** A higher timestamp from another author is not evidence that it observed this version. */
export function sawVersion(next: Field, old: Field) {
  if (!old.hlc || next.prev === old.hlc) return true;
  const author = clockParts(old.hlc).node;

  return (next.seen ?? []).some((clock) => clockParts(clock).node === author && compareClock(clock, old.hlc) >= 0);
}

/** A local edit acknowledges its current version and all alternatives received for this field. */
export function fieldAncestry(
  sql: SqlClient.SqlClient,
  owner: string,
  row: ConfigRow,
  name: string,
  alternatives: readonly (Ancestry & { hlc: string })[] = [],
) {
  return Effect.gen(function* () {
    const current = name === "deleted" ? row.deleted : row.fields[name];

    const pending = yield* sql<{
      hlc: string;
      ancestry: Ancestry;
    }>`SELECT hlc,ancestry FROM config_history WHERE owner_user_id=${owner}::uuid
      AND kind=${row.kind} AND global_id=${row.global_id} AND field=${name} AND reason='choice' AND state='open'`;

    const byAuthor = new Map<string, string>();
    let prev = current?.hlc ?? "";

    const versions = [...alternatives, ...pending.map((p) => ({ ...p.ancestry, hlc: p.hlc }))];

    for (const clock of [
      ...(current?.seen ?? []),
      current?.prev ?? "",
      prev,
      ...versions.flatMap((p) => [...p.seen, p.prev, p.hlc]),
    ]) {
      if (!clock) continue;
      const author = clockParts(clock).node;

      if (compareClock(clock, byAuthor.get(author) ?? "") > 0) byAuthor.set(author, clock);

      if (compareClock(clock, prev) > 0) prev = clock;
    }

    return { prev, seen: [...byAuthor.values()].sort(compareClock) };
  });
}
