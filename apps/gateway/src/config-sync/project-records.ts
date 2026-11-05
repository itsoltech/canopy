import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { configLock, type ConfigRow } from "./persistence.ts";
import { instanceIds } from "./aliases.ts";
import { mapSettingsInstances, type SettingsJson } from "./settings.ts";
import { ambiguousProjectOrigin, policyValues, projectSettingsValues } from "./project-values.ts";
import { projectWriter } from "./project-writer.ts";

type ProjectRow = {
  id: string;
  name: string;
  kind: string;
  archived_at: Date | null;
  updated_at: Date;
  origin: string;
  config_deleted: boolean;
  has_workspace: boolean;
};

type SettingsRow = { project_id: string | null; settings: SettingsJson; updated_at: Date };

/** Local domain writes and versions commit together, with the configuration clock locked first. */
export const projectTransaction = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT 1 FROM config_clock ORDER BY owner_user_id FOR UPDATE`;
      const value = yield* effect;
      yield* recordProjects(sql);

      return value;
    }),
  );

export function recordProjects(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const owners = yield* sql<{ owner_user_id: string; node_id: string }>`SELECT owner_user_id::text,node_id
      FROM computer_identity ORDER BY owner_user_id`;

    for (const owner of owners) yield* recordOwner(sql, owner.owner_user_id, owner.node_id);
  });
}

function recordOwner(sql: SqlClient.SqlClient, owner: string, node: string) {
  return Effect.gen(function* () {
    const clock = yield* configLock(sql, owner);

    const records = [
      ...(yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('project','project_settings','worktree_policy')`),
    ];

    const projects = yield* sql<ProjectRow>`SELECT p.id::text,p.name,p.kind,p.archived_at,p.updated_at,p.config_deleted,
      count(w.id)>0 AS has_workspace,
      CASE WHEN count(w.id)>0 AND bool_and(w.git_origin<>'') AND count(DISTINCT w.git_origin)=1
        THEN min(w.git_origin) ELSE '' END AS origin FROM projects p
      LEFT JOIN project_workspaces w ON w.project_id=p.id AND w.archived_at IS NULL
      WHERE p.owner_user_id=${owner}::uuid GROUP BY p.id ORDER BY p.id`;

    const settings = yield* sql<SettingsRow>`SELECT s.project_id::text,s.settings,s.updated_at FROM project_settings s
      JOIN projects p ON p.id=s.project_id WHERE p.owner_user_id=${owner}::uuid AND p.kind<>'scratch' AND NOT p.config_deleted`;

    const policies = yield* sql<SettingsRow>`SELECT s.project_id::text,s.settings,s.updated_at FROM worktree_settings s
      LEFT JOIN projects p ON p.id=s.project_id WHERE s.owner_user_id=${owner}::uuid AND s.worker_id IS NULL
      AND (s.project_id IS NULL OR (p.owner_user_id=${owner}::uuid AND NOT p.config_deleted))`;

    const ids = yield* instanceIds(sql, owner);
    const { recordFor, update, finish } = projectWriter(sql, owner, node, records, clock.hlc);

    for (const p of projects) {
      if (p.config_deleted) continue;
      const row = recordFor("project", p.id, p.kind === "scratch" ? "scratch" : p.id);

      // A workspace-less replica keeps the known shared origin; local workspaces are the authority when present.
      const origin = p.has_workspace ? p.origin : String(row.fields["origin"]?.value ?? "");

      const ambiguous =
        !!origin && projects.filter((other) => other.origin === origin && !other.archived_at).length > 1;

      row.identity =
        origin && !ambiguous && !ambiguousProjectOrigin(row.fields, origin, `originAmbiguous.${node}`)
          ? `origin:${origin}`
          : "";
      yield* update(
        row,
        {
          name: p.name,
          kind: p.kind,
          archived: !!p.archived_at,
          origin,
          [`originAmbiguous.${node}`]: ambiguous ? origin : null,
        },
        p.updated_at,
      );
    }

    const projectGlobal = (local: string) =>
      records.find((r) => r.kind === "project" && r.local_id === local)?.global_id ?? local;

    for (const s of settings) {
      if (!s.project_id) continue;
      yield* update(
        recordFor("project_settings", s.project_id, projectGlobal(s.project_id)),
        mapSettingsInstances(projectSettingsValues(s.settings), ids.toGlobal),
        s.updated_at,
      );
    }

    for (const s of policies)
      yield* update(
        recordFor("worktree_policy", s.project_id ?? "account", s.project_id ? projectGlobal(s.project_id) : "account"),
        policyValues(s.settings),
        s.updated_at,
      );

    yield* finish();
  });
}
