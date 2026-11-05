import { Schema } from "effect";
import type { ConfigRow } from "./persistence.ts";

const names = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const nameList = Schema.is(Schema.Array(Schema.String));
const name = Schema.is(Schema.String);

export function supportedComputer(row: ConfigRow) {
  return row.schema_version === 1 && name(row.fields["name"]?.value) && nameList(row.fields["neighbors"]?.value);
}

/** Require both endpoints' latest declarations. A stale disconnected component cannot add itself. */
export function configGroup(rows: readonly ConfigRow[], self: string, direct: string[], omit = "") {
  const computers = new Map(
    rows.flatMap((r) => (r.kind === "computer" && supportedComputer(r) ? [[r.global_id, r] as const] : [])),
  );

  const edges = (id: string) =>
    id === self ? direct.filter((n) => n !== omit) : [...names(computers.get(id)?.fields["neighbors"]?.value ?? [])];

  const group = new Set([self]);
  const pending = [self];

  while (pending.length) {
    const id = pending.shift()!;

    for (const other of edges(id)) {
      if ((other === omit && id === self) || (id === omit && other === self)) continue;

      if (group.has(other) || !edges(other).includes(id)) continue;
      group.add(other);
      pending.push(other);
    }
  }

  return [...group].map((id) => ({
    nodeId: id,
    name: String(computers.get(id)?.fields["name"]?.value ?? "Linked computer"),
  }));
}
