import type { DescMessage, Message } from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { splitId } from "@canopy/domain/computers";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { mapIds } from "../computers/remote-ids.ts";
import { queryFamily } from "../diagnostics/query-context.ts";

export type ProjectIds = {
  toGlobal(id: string): string;
  toLocal(id: string): string;
  known: Set<string>;
  local: Set<string>;
};

export function projectIds(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    const records = yield* sql<{ global_id: string; local_id: string }>`SELECT global_id,local_id FROM config_items
      WHERE owner_user_id=${owner}::uuid AND kind='project' AND unsupported=''`;

    const aliases = yield* sql<{ alias_id: string; global_id: string }>`SELECT alias_id,global_id FROM config_aliases
      WHERE owner_user_id=${owner}::uuid AND kind='project'`;

    const locals = new Map(records.map((r) => [r.global_id, r.local_id]));
    const globals = new Map(records.map((r) => [r.local_id, r.global_id]));
    const alias = new Map(aliases.map((a) => [a.alias_id, a.global_id]));
    const canonical = (id: string) => alias.get(id) ?? globals.get(id) ?? id;

    return {
      toGlobal: (id: string) => canonical(splitId(id).id),
      toLocal: (id: string) => locals.get(canonical(splitId(id).id)) ?? id,
      known: new Set([...locals.keys(), ...globals.keys(), ...alias.keys()]),
      local: new Set(globals.keys()),
    };
  }).pipe(queryFamily("config.sync"));
}

/** Only project references are shared. Workspaces, workers and worktrees always keep their computer suffix. */
export function mapProjectIds(desc: DescMessage, message: Message, map: (id: string) => string) {
  mapIds(
    desc,
    message,
    (id, field) => (field === "project_id" || field === "project_ids" ? map(id) : id),
    (d, m) => {
      if (d.typeName !== "canopy.ui.v1.Project") return;
      const record = reflect(d, m);
      const field = d.field["id"]!;
      record.set(field, map(String(record.get(field))));
    },
  );
}
