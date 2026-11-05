import { create, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { Effect, Option, Predicate, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { instanceIds } from "../config-sync/aliases.ts";
import type { ConfigRow } from "../config-sync/persistence.ts";
import { projectIds } from "../config-sync/project-aliases.ts";
import { globalIds, WORKER_KIND } from "../config-sync/worker-records.ts";
import type { GatewayCore } from "../core/core.ts";
import { providerOf } from "../store/instance-config.ts";
import { storedSettings } from "../worktrees/settings.ts";
import { ConfigIds } from "./routed-config.ts";

const strings = Schema.is(Schema.Array(Schema.String));

const workspaces = Schema.is(
  Schema.Array(
    Schema.Struct({ id: Schema.String, project: Schema.String, path: Schema.String, worktrees: Schema.Number }),
  ),
);

const instancesOf = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.NullOr(Schema.Boolean), keySet: Schema.Boolean })),
);

const scopesOf = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.MutableJson));

/** Copies of other computers' worker records, as their homes last wrote them (newest first per field). */
export async function workerRecordRows(core: GatewayCore): Promise<ConfigRow[]> {
  const computers = core.computers;

  if (!computers?.config) return [];

  return (
    await computers.store.query<ConfigRow>(
      `SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind=$2 AND home_node_id<>$3 AND unsupported=''
      ORDER BY home_node_id,global_id`,
      [computers.store.owner, WORKER_KIND, computers.hello().nodeId],
    )
  ).filter((row) => row.deleted.value !== true);
}

/** Why this computer cannot change a worker of `node` now; empty when the edit goes to its home. */
export async function editBlocked(core: GatewayCore, node: string, name: string): Promise<string> {
  const computers = core.computers;

  if (!computers) return `Change this worker's settings on “${name}”.`;
  const peer = await computers.store.peer(node);

  if (!peer || peer.via_node_id) return `Change this worker's settings on “${name}”.`;

  if (!(await ConfigIds.carries(core, node)))
    return `Turn on Share configuration with “${name}” to change its workers' settings.`;

  if (!computers.reachable().includes(node)) return (await computers.unavailable(node)).rawMessage;

  return "";
}

const valueOf = (row: ConfigRow, name: string): JsonValue | undefined => row.fields[name]?.value;

/** Every worker of the configuration group's other computers, with the ids this computer uses. */
export async function listWorkerRecords(core: GatewayCore): Promise<ui.ListWorkerRecordsResponse> {
  const computers = core.computers;
  const rows = await workerRecordRows(core);

  if (!computers || !rows.length) return create(ui.ListWorkerRecordsResponseSchema);
  const store = computers.store;

  const ids = await store.runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all({
        instances: instanceIds(sql, store.owner),
        projects: projectIds(sql, store.owner),
        connectors: globalIds(sql, store.owner, "connector"),
      }),
    ),
  );

  const names = new Map<string, string>();
  const reasons = new Map<string, string>();

  for (const node of new Set(rows.map((r) => r.home_node_id))) {
    const peer = await store.computer(node);

    const record = (
      await store.query<ConfigRow>(
        "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind='computer' AND global_id=$2",
        [store.owner, node],
      )
    )[0];

    const recorded = record?.fields["name"]?.value;
    names.set(node, peer?.display_name || peer?.name || (Predicate.isString(recorded) ? recorded : "Linked computer"));
    reasons.set(node, await editBlocked(core, node, names.get(node)!));
  }

  const records = rows.map((row) => {
    const text = (name: string) => {
      const value = valueOf(row, name);

      return Predicate.isString(value) ? value : "";
    };

    const list = (name: string) => {
      const value = valueOf(row, name);

      return strings(value) ? [...value] : [];
    };

    const minutes = valueOf(row, "cliUpdateCheckMinutes");
    const placed = Option.getOrElse(instancesOf(valueOf(row, "instances")), () => ({}));
    const worktree = Option.getOrElse(scopesOf(valueOf(row, "worktree")), () => ({}));
    const updated = Math.max(0, ...Object.values(row.fields).map((f) => Number(f.hlc.split(".")[0])));

    return create(ui.WorkerRecordSchema, {
      workerId: qualifyId(row.global_id, row.home_node_id),
      nodeId: row.home_node_id,
      computerName: names.get(row.home_node_id) ?? "",
      name: text("name"),
      os: text("os"),
      arch: text("arch"),
      hostname: text("hostname"),
      revoked: valueOf(row, "revoked") === true,
      manualTags: list("tags"),
      automaticTags: list("automaticTags"),
      ...(Predicate.isNumber(minutes) && { cliUpdateCheckMinutes: minutes }),
      instances: Object.entries(placed).flatMap(([key, value]) => {
        const [harness = "", slug = ""] = key.split(":");

        return harness && slug
          ? [
              create(ui.WorkerRecordInstanceSchema, {
                harness: providerOf(harness),
                id: ids.instances.toLocal(harness, slug),
                ...(value.enabled !== null && { enabled: value.enabled }),
                keySet: value.keySet,
              }),
            ]
          : [];
      }),
      connectorAccountIds: list("connectors").map(ids.connectors.toLocal),
      workspaces: (() => {
        const value = valueOf(row, "workspaces");

        return workspaces(value)
          ? value.map((w) =>
              create(ui.WorkerRecordWorkspaceSchema, {
                id: qualifyId(w.id, row.home_node_id),
                projectId: ids.projects.toLocal(w.project),
                rootPath: w.path,
                worktrees: w.worktrees,
              }),
            )
          : [];
      })(),
      worktreeSettings: Object.entries(worktree).flatMap(([project, settings]) => {
        try {
          return [
            create(ui.WorkerRecordWorktreeSettingsSchema, {
              projectId: project && ids.projects.toLocal(project),
              settings: storedSettings(settings),
            }),
          ];
        } catch {
          return [];
        }
      }),
      ...(updated > 0 && { updatedAt: timestampFromMs(updated) }),
      readOnlyReason: reasons.get(row.home_node_id) ?? "",
    });
  });

  return create(ui.ListWorkerRecordsResponseSchema, { records });
}
