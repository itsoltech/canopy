import { type JsonValue } from "@bufbuild/protobuf";
import { Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { nextClock } from "./clock.ts";
import { instanceIds } from "./aliases.ts";
import { configLock, emptyRecord, equalValue, type ConfigRow } from "./persistence.ts";
import { saveRecords } from "./record-batches.ts";
import { projectIds } from "./project-aliases.ts";
import { queryFamily } from "../diagnostics/query-context.ts";

/**
 * Worker records (docs/linked-computers.md, "Rekordy workerów i edycja zdalna"). Only the worker's home writes
 * them, from its own tables; other computers of the configuration group keep a read-only copy. Values carry
 * global ids and never a secret: a worker's own instance key is only `keySet`.
 */
export const WORKER_KIND = "worker";

type WorkerRow = { id: string; name: string; os: string; arch: string; hostname: string | null; revoked: boolean };

type InstanceRow = {
  harness: string;
  instance_id: string;
  worker_id: string;
  enabled: boolean | null;
  overrides: JsonValue;
  own_key: boolean;
};

/** Local ids of one shared kind to their global ids (aliases resolve to the canonical id). */
export function globalIds(sql: SqlClient.SqlClient, owner: string, kind: string) {
  return Effect.gen(function* () {
    const records = yield* sql<{ global_id: string; local_id: string }>`SELECT global_id,local_id FROM config_items
      WHERE owner_user_id=${owner}::uuid AND kind=${kind} AND unsupported=''`;

    const aliases = yield* sql<{ alias_id: string; global_id: string }>`SELECT alias_id,global_id FROM config_aliases
      WHERE owner_user_id=${owner}::uuid AND kind=${kind}`;

    const globals = new Map(records.map((r) => [r.local_id || r.global_id, r.global_id]));
    const locals = new Map(records.map((r) => [r.global_id, r.local_id || r.global_id]));
    const alias = new Map(aliases.map((a) => [a.alias_id, a.global_id]));

    return {
      toGlobal: (id: string) => alias.get(id) ?? globals.get(id) ?? id,
      toLocal: (id: string) => locals.get(alias.get(id) ?? id) ?? id,
    };
  }).pipe(queryFamily("settings.store"));
}

const Overrides = Schema.Struct({
  apiKey: Schema.optional(Schema.Unknown),
  env: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
});

const overridesOf = Schema.decodeUnknownOption(Overrides);
const names = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** What a worker's own instance settings say, without values: names of overrides and whether it has a key. */
function instanceValue(row: InstanceRow): JsonValue {
  const overrides = Option.getOrUndefined(overridesOf(row.overrides));

  return {
    enabled: row.enabled,
    keySet: row.own_key || (overrides?.apiKey !== undefined && overrides.apiKey !== null),
    overrides: (names(row.overrides) ? Object.keys(row.overrides) : [])
      .filter((key) => key !== "apiKey" && key !== "env")
      .sort(),
    env: (overrides?.env ?? []).map((v) => v.name).sort(),
  };
}

function homeValues(
  sql: SqlClient.SqlClient,
  owner: string,
): Effect.Effect<Map<string, Map<string, JsonValue>>, SqlError.SqlError> {
  return Effect.gen(function* () {
    const workers = yield* sql<WorkerRow>`SELECT id::text,name,os,arch,capabilities->>'hostname' AS hostname,
      revoked_at IS NOT NULL AS revoked FROM workers WHERE owner_user_id=${owner}::uuid AND archived_at IS NULL ORDER BY id`;

    const configs = yield* sql<{ worker_id: string; minutes: number | null }>`SELECT c.worker_id::text,
      (c.config->>'cliUpdateCheckMinutes')::int AS minutes FROM worker_configs c JOIN workers w ON w.id=c.worker_id
      WHERE w.owner_user_id=${owner}::uuid`;

    const environments = yield* sql<{ worker_id: string; manual_tags: string[]; automatic_tags: string[] }>`SELECT
      e.worker_id::text,e.manual_tags,e.automatic_tags FROM worker_environments e JOIN workers w ON w.id=e.worker_id
      WHERE w.owner_user_id=${owner}::uuid`;

    const instances = yield* sql<InstanceRow>`SELECT i.harness,i.instance_id,i.worker_id::text,i.enabled,i.overrides,
        COALESCE(p.worker_scoped AND p.secret_id IS NOT NULL,false) AS own_key
      FROM provider_instance_workers i JOIN workers w ON w.id=i.worker_id LEFT JOIN proxies p ON p.id=i.proxy_id
      WHERE w.owner_user_id=${owner}::uuid`;

    const grants = yield* sql<{ account_id: string; worker_id: string }>`SELECT g.account_id::text,g.worker_id::text
      FROM connector_worker_grants g JOIN connector_accounts a ON a.id=g.account_id WHERE a.owner_user_id=${owner}::uuid`;

    const workspaces = yield* sql<{
      id: string;
      project_id: string;
      worker_id: string;
      root_path: string;
      worktrees: number;
    }>`
      SELECT ws.id::text,ws.project_id::text,ws.worker_id::text,ws.root_path,
        (SELECT count(*) FROM worktrees t WHERE t.workspace_id=ws.id AND t.removed_at IS NULL)::int AS worktrees
      FROM project_workspaces ws JOIN projects p ON p.id=ws.project_id
      WHERE p.owner_user_id=${owner}::uuid AND ws.archived_at IS NULL ORDER BY ws.id`;

    const worktree = yield* sql<{ project_id: string | null; worker_id: string; settings: JsonValue }>`SELECT
      project_id::text,worker_id::text,settings FROM worktree_settings WHERE owner_user_id=${owner}::uuid AND worker_id IS NOT NULL`;

    const instance = yield* instanceIds(sql, owner);
    const projects = yield* projectIds(sql, owner);
    const connectors = yield* globalIds(sql, owner, "connector");
    const values = new Map<string, Map<string, JsonValue>>();

    for (const w of workers) {
      const environment = environments.find((e) => e.worker_id === w.id);
      const minutes = configs.find((c) => c.worker_id === w.id)?.minutes;

      const own = new Map<string, JsonValue>(
        Object.entries({
          name: w.name,
          os: w.os,
          arch: w.arch,
          hostname: w.hostname ?? "",
          revoked: w.revoked,
          tags: [...(environment?.manual_tags ?? [])].sort(),
          automaticTags: [...(environment?.automatic_tags ?? [])].sort(),
          cliUpdateCheckMinutes: minutes ?? null,
          connectors: grants
            .filter((g) => g.worker_id === w.id)
            .map((g) => connectors.toGlobal(g.account_id))
            .sort(),
          workspaces: workspaces
            .filter((s) => s.worker_id === w.id)
            .map((s) => ({
              id: s.id,
              project: projects.toGlobal(s.project_id),
              path: s.root_path,
              worktrees: s.worktrees,
            })),
          // Keyed by `harness:global id` and by the project's global id ("" = the worker's own scope).
          instances: Object.fromEntries(
            instances
              .filter((i) => i.worker_id === w.id)
              .map((row) => [`${row.harness}:${instance.toGlobal(row.harness, row.instance_id)}`, instanceValue(row)]),
          ),
          worktree: Object.fromEntries(
            worktree
              .filter((t) => t.worker_id === w.id)
              .map((row) => [row.project_id ? projects.toGlobal(row.project_id) : "", row.settings]),
          ),
        } satisfies Record<string, JsonValue>),
      );

      values.set(w.id, own);
    }

    return values;
  });
}

/** Writes this computer's worker records: a new clock for each changed field, a tombstone for a removed worker. */
export function recordWorkers(sql: SqlClient.SqlClient, owner: string, node: string) {
  return Effect.gen(function* () {
    const clock = yield* configLock(sql, owner);

    const records = yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind=${WORKER_KIND} AND home_node_id=${node}`;

    const values = yield* homeValues(sql, owner);
    const pending: ConfigRow[] = [];
    const byId = new Map(records.map((row) => [row.global_id, row]));
    let last = clock.hlc;
    let changed = false;

    for (const [id, own] of values) {
      const row = byId.get(id) ?? emptyRecord(WORKER_KIND, id, node);
      let dirty = false;

      if (row.deleted.value === true) {
        last = nextClock(last, node);
        row.deleted = { value: false, hlc: last, prev: row.deleted.hlc };
        dirty = true;
      }

      for (const name of new Set([...Object.keys(row.fields), ...own.keys()])) {
        const value = own.get(name) ?? null;

        if (row.fields[name] && equalValue(row.fields[name].value, value)) continue;

        if (!row.fields[name] && value === null) continue;
        last = nextClock(last, node);
        row.fields[name] = { value, hlc: last, prev: row.fields[name]?.hlc ?? "" };
        dirty = true;
      }

      if (dirty) pending.push(row);
      changed ||= dirty;
    }

    for (const row of records) {
      if (values.has(row.global_id) || row.deleted.value === true) continue;
      last = nextClock(last, node);
      row.deleted = { value: true, hlc: last, prev: row.deleted.hlc };
      row.fields = {};
      pending.push(row);
      changed = true;
    }

    yield* saveRecords(sql, owner, pending, last);

    return changed;
  });
}

/** A copy is valid only as its home wrote it: every clock is the home's and no field holds a secret. */
export function homeWritten(row: ConfigRow) {
  const node = (hlc: string) => hlc.slice(hlc.lastIndexOf(".") + 1);

  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.global_id) &&
    /^[a-f0-9]{64}$/.test(row.home_node_id) &&
    (!row.deleted.hlc || node(row.deleted.hlc) === row.home_node_id) &&
    Object.values(row.fields).every((field) => node(field.hlc) === row.home_node_id)
  );
}
