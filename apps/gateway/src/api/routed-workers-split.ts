import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { connectors, ui } from "@canopy/contracts";
import { qualifyId, splitId } from "@canopy/domain/computers";
import type { HandlerContext } from "@connectrpc/connect";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { methodNamed } from "../computers/remote.ts";
import { instanceIds } from "../config-sync/aliases.ts";
import type { ConfigRow } from "../config-sync/persistence.ts";
import { globalIds } from "../config-sync/worker-records.ts";
import type { GatewayCore } from "../core/core.ts";
import { harnessOf } from "../store/instance-config.ts";
import { single } from "./routed-context.ts";
import { workerRecordRows } from "./worker-records.ts";
import { auditWorkerEdit, refuseWithoutConfig, settled } from "./routed-workers.ts";
import type { UiHandlers } from "./ui-service.ts";

/**
 * Access lists that name workers of several computers (docs/linked-computers.md, "Rekordy workerów i edycja
 * zdalna"): this computer writes the shared part and its own workers, each other home its workers. Every home
 * that has to change is checked first, so an unreachable one fails the edit before anything is written.
 */
const enabledOf = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.NullOr(Schema.Boolean) })),
);

type Change = { node: string; request: Message; workers: string[] };

async function homeOf(core: GatewayCore, id: string) {
  return (await core.computers!.resolve(splitId(id).node!)).node_id;
}

async function deliver(core: GatewayCore, method: DescMethod, changes: readonly Change[], signal: AbortSignal) {
  const computers = core.computers!;

  for (const node of new Set(changes.map((c) => c.node))) {
    await refuseWithoutConfig(core, node);

    if (!computers.reachable().includes(node)) throw await computers.unavailable(node);
  }

  return async () => {
    for (const change of changes) {
      await single(computers.remote(change.node, method, change.request, signal));
      await auditWorkerEdit(core, "sent", method.name, change.node, change.workers);
    }
  };
}

function shared(core: GatewayCore) {
  const store = core.computers!.store;

  return store.runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all({ connectors: globalIds(sql, store.owner, "connector"), instances: instanceIds(sql, store.owner) }),
    ),
  );
}

const granted = (row: ConfigRow, account: string) => {
  const value = row.fields["connectors"]?.value;

  return Array.isArray(value) && value.includes(account);
};

export async function setConnectorAccess(
  core: GatewayCore,
  local: UiHandlers,
  request: connectors.SetConnectorAccessRequest,
  context: HandlerContext,
): Promise<connectors.ConnectorAccountResponse> {
  if (!core.computers?.config)
    return create(connectors.ConnectorAccountResponseSchema, await local.setConnectorAccess(request, context));
  const ids = await shared(core);
  const account = ids.connectors.toGlobal(request.accountId);
  const wanted = new Set(request.workerIds.filter((id) => splitId(id).node));
  const homes = new Map<string, string[]>();

  for (const row of await workerRecordRows(core)) {
    const id = qualifyId(row.global_id, row.home_node_id);

    if (granted(row, account) !== wanted.has(id)) homes.set(row.home_node_id, []);
  }

  for (const id of wanted) homes.set(await homeOf(core, id), []);

  for (const id of wanted) homes.get(await homeOf(core, id))!.push(splitId(id).id);
  const method = methodNamed("SetConnectorAccess")!;

  const send = await deliver(
    core,
    method,
    [...homes].map(([node, workerIds]) => ({
      node,
      request: create(connectors.SetConnectorAccessRequestSchema, { accountId: account, workerIds }),
      workers: workerIds,
    })),
    context.signal,
  );

  const own = request.workerIds.filter((id) => !splitId(id).node);

  const response = create(
    connectors.ConnectorAccountResponseSchema,
    await local.setConnectorAccess(
      create(connectors.SetConnectorAccessRequestSchema, { ...request, workerIds: own }),
      context,
    ),
  );

  await send();
  response.account?.workerIds.push(...wanted);

  return response;
}

/** Accounts list every computer's workers with access, from the homes' records. */
export async function listConnectors(
  core: GatewayCore,
  local: UiHandlers,
  request: connectors.ListConnectorsRequest,
  context: HandlerContext,
): Promise<connectors.ListConnectorsResponse> {
  const response = create(connectors.ListConnectorsResponseSchema, await local.listConnectors(request, context));
  const rows = await workerRecordRows(core);

  if (!rows.length) return response;
  const ids = await shared(core);

  for (const account of response.accounts) {
    const global = ids.connectors.toGlobal(account.id);

    for (const row of rows)
      if (granted(row, global)) account.workerIds.push(qualifyId(row.global_id, row.home_node_id));
  }

  return response;
}

export async function setInstanceWorkers(
  core: GatewayCore,
  local: UiHandlers,
  request: ui.SetInstanceWorkersRequest,
  context: HandlerContext,
): Promise<ui.SetInstanceWorkersResponse> {
  const harness = harnessOf(request.harness);

  if (!core.computers?.config || !harness)
    return create(ui.SetInstanceWorkersResponseSchema, await local.setInstanceWorkers(request, context));
  const ids = await shared(core);
  const before = (await core.listProviderInstances()).find((i) => i.harness === request.harness && i.id === request.id);
  const key = `${harness}:${ids.instances.toGlobal(harness, request.id)}`;
  const wanted = new Set(request.workerIds.filter((id) => splitId(id).node));
  const changes: Change[] = [];

  const change = (node: string, workerId: string, enabled: boolean) =>
    changes.push({
      node,
      request: create(ui.SetInstanceWorkerRequestSchema, {
        harness: request.harness,
        id: ids.instances.toGlobal(harness, request.id),
        workerId,
        enabled,
      }),
      workers: [workerId],
    });

  for (const row of await workerRecordRows(core)) {
    const explicit = Option.getOrUndefined(enabledOf(row.fields["instances"]?.value))?.[key]?.enabled ?? undefined;
    const enabled = request.allWorkers || wanted.delete(qualifyId(row.global_id, row.home_node_id));

    if ((explicit ?? before?.allWorkers ?? false) !== enabled) change(row.home_node_id, row.global_id, enabled);
  }

  for (const id of wanted) change(await homeOf(core, id), splitId(id).id, true);
  const send = await deliver(core, methodNamed("SetInstanceWorker")!, changes, context.signal);

  const response = create(
    ui.SetInstanceWorkersResponseSchema,
    await local.setInstanceWorkers(
      create(ui.SetInstanceWorkersRequestSchema, {
        ...request,
        workerIds: request.workerIds.filter((id) => !splitId(id).node),
      }),
      context,
    ),
  );

  await send();

  return response;
}

/** The routed handlers that split access lists by home; this computer's records follow its own part. */
export function splitOverrides(core: GatewayCore, local: UiHandlers): Partial<UiHandlers> {
  return {
    setConnectorAccess: (request, context) =>
      settled(core, undefined, setConnectorAccess(core, local, request, context)),
    setInstanceWorkers: (request, context) =>
      settled(core, undefined, setInstanceWorkers(core, local, request, context)),
    listConnectors: (request, context) => listConnectors(core, local, request, context),
  };
}
