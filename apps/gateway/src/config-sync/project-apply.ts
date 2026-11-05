import { fromJson, toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect, Predicate, Result, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { equalValue, type ConfigRow } from "./persistence.ts";
import { alive } from "./provider-records.ts";
import { canonicalId, NOT_SUPPORTED, recordOf } from "./provider-apply.ts";
import { instanceIds } from "./aliases.ts";
import { mapSettingsInstances, type SettingsJson } from "./settings.ts";
import { DEFAULT_FIELDS, knownProjectOrigin, patchLeaves, POLICY_FIELDS, UUID } from "./project-values.ts";
import { valuesOf } from "./provider-values.ts";
import { settingsProblem } from "../worktrees/settings.ts";
import type { SharedHost } from "./host.ts";

type Stored = { settings: SettingsJson };

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));

/** Logical deletion retains placement foreign keys and local paths for history and Restore. */
export function applyProject(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  return Effect.gen(function* () {
    if (row.global_id === "scratch") {
      const scratch = (yield* sql<{ id: string }>`SELECT id::text FROM projects
        WHERE owner_user_id=${owner}::uuid AND kind='scratch'`)[0];

      if (scratch) row.local_id = scratch.id;

      return;
    }

    if (!UUID.test(row.local_id)) return void (row.unsupported = NOT_SUPPORTED);

    const existing = (yield* sql<{ owner_user_id: string }>`SELECT owner_user_id::text FROM projects
      WHERE id=${row.local_id}::uuid`)[0];

    if (existing && existing.owner_user_id !== owner) return void (row.unsupported = NOT_SUPPORTED);

    if (!alive(row)) {
      yield* sql`UPDATE projects SET archived_at=COALESCE(archived_at,now()),config_deleted=true
        WHERE owner_user_id=${owner}::uuid AND id=${row.local_id}::uuid AND kind<>'scratch'`;
      yield* cancelSchedules(sql, owner, row.local_id);

      return;
    }

    const v = valuesOf(row.fields);
    const name = v["name"];

    if (
      !Predicate.isString(name) ||
      !name.trim() ||
      name.length > 200 ||
      /[\r\n\p{Cc}]/u.test(name) ||
      v["kind"] !== "project" ||
      !Predicate.isBoolean(v["archived"]) ||
      !Predicate.isString(v["origin"]) ||
      (!!v["origin"] && !knownProjectOrigin(v["origin"]))
    )
      return void (row.unsupported = NOT_SUPPORTED);
    yield* sql`INSERT INTO projects(id,owner_user_id,name,slug,kind,archived_at)
      VALUES(${row.local_id}::uuid,${owner}::uuid,${name},${`project-${row.local_id}`},'project',
        CASE WHEN ${v["archived"]} THEN now() ELSE NULL END)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,archived_at=excluded.archived_at,
        config_deleted=false,updated_at=now() WHERE projects.owner_user_id=${owner}::uuid AND projects.kind='project'`;

    if (v["archived"]) yield* cancelSchedules(sql, owner, row.local_id);
  });
}

function cancelSchedules(sql: SqlClient.SqlClient, owner: string, project: string) {
  return sql`UPDATE schedules SET status='cancelled',next_run_at=NULL,lease_owner=NULL,lease_until=NULL,version=version+1
    WHERE project_id=${project}::uuid AND project_id IN (SELECT id FROM projects WHERE owner_user_id=${owner}::uuid)
      AND status IN ('active','paused')`;
}

/** Child records name their project's global identity; local_id stays the receiving project's id. */
export function applyProjectConfiguration(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, host: SharedHost) {
  return Effect.gen(function* () {
    if (row.kind === "project_settings" && row.global_id === "account") return void (row.unsupported = NOT_SUPPORTED);

    const project =
      row.global_id === "account" && row.kind === "worktree_policy"
        ? undefined
        : yield* recordOf(sql, owner, "project", yield* canonicalId(sql, owner, "project", row.global_id));

    if (!project && row.global_id !== "account") return;
    const local = project?.local_id ?? "account";

    if (local !== "account" && !UUID.test(local)) return void (row.unsupported = NOT_SUPPORTED);
    row.local_id = local;

    if (
      local !== "account" &&
      !(yield* sql`SELECT 1 FROM projects WHERE id=${local}::uuid
      AND owner_user_id=${owner}::uuid`).length
    )
      return;

    if (row.kind === "project_settings") yield* applyDefaults(sql, owner, row, host);
    else yield* applyPolicy(sql, owner, row);
  });
}

function applyDefaults(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, host: SharedHost) {
  return Effect.gen(function* () {
    const current = (yield* sql<Stored>`SELECT s.settings FROM project_settings s JOIN projects p ON p.id=s.project_id
      WHERE s.project_id=${row.local_id}::uuid AND p.owner_user_id=${owner}::uuid`)[0];

    const ids = yield* instanceIds(sql, owner);
    const values = mapSettingsInstances(valuesOf(row.fields), ids.toLocal);
    const patch = alive(row) ? values : Object.fromEntries([...DEFAULT_FIELDS].map((f) => [f, null]));
    const next = patchLeaves(current?.settings ?? {}, patch, DEFAULT_FIELDS);

    if (current && equalValue(current.settings, next)) return;

    const parsed = yield* Effect.try(() =>
      fromJson(ui.ThreadDefaultsSchema, next["threadDefaults"] ?? {}, { ignoreUnknownFields: true }),
    ).pipe(Effect.result);

    if (Result.isFailure(parsed)) return void (row.unsupported = NOT_SUPPORTED);

    const valid = yield* Effect.tryPromise(
      () => host.validateProjectSettings?.({ ...parsed.success, workspaceId: "" }) ?? Promise.resolve(),
    ).pipe(Effect.result);

    if (Result.isFailure(valid)) return void (row.unsupported = NOT_SUPPORTED);
    yield* sql`INSERT INTO project_settings(project_id,settings,version,updated_by)
      VALUES(${row.local_id}::uuid,${JSON.stringify(next)}::jsonb,1,${owner}::uuid)
      ON CONFLICT(project_id) DO UPDATE SET settings=excluded.settings,version=project_settings.version+1,
        updated_at=now(),updated_by=excluded.updated_by`;
  });
}

function applyPolicy(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  return Effect.gen(function* () {
    const project = row.local_id === "account" ? null : row.local_id;

    const current = (yield* sql<Stored>`SELECT settings FROM worktree_settings WHERE owner_user_id=${owner}::uuid
      AND project_id IS NOT DISTINCT FROM ${project}::uuid AND worker_id IS NULL`)[0];

    const patch = alive(row) ? valuesOf(row.fields) : Object.fromEntries([...POLICY_FIELDS].map((f) => [f, null]));
    const next = patchLeaves(current?.settings ?? {}, patch, POLICY_FIELDS);

    if (current && equalValue(current.settings, next)) return;

    const parsed = yield* Effect.try(() =>
      fromJson(ui.WorktreeSettingsSchema, next, { ignoreUnknownFields: true }),
    ).pipe(Effect.result);

    if (Result.isFailure(parsed) || settingsProblem(parsed.success, () => true))
      return void (row.unsupported = NOT_SUPPORTED);
    const json = { ...next, ...object(toJson(ui.WorktreeSettingsSchema, parsed.success)) };
    yield* sql`INSERT INTO worktree_settings(owner_user_id,project_id,settings)
      VALUES(${owner}::uuid,${project}::uuid,${JSON.stringify(json)}::jsonb)
      ON CONFLICT(owner_user_id,project_id,worker_id) DO UPDATE SET settings=excluded.settings,
        version=worktree_settings.version+1,updated_at=now()`;
  });
}
