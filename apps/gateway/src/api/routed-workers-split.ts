import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { qualifyId, splitId } from "@canopy/domain/computers";
import type { HandlerContext } from "@connectrpc/connect";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { methodNamed } from "../computers/remote.ts";
import { instanceIds } from "../config-sync/aliases.ts";
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

function sharedInstances(core: GatewayCore) {
  const store = core.computers!.store;

  return store.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => instanceIds(sql, store.owner)));
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
  const ids = await sharedInstances(core);
  const before = (await core.listProviderInstances()).find((i) => i.harness === request.harness && i.id === request.id);
  const key = `${harness}:${ids.toGlobal(harness, request.id)}`;
  const wanted = new Set(request.workerIds.filter((id) => splitId(id).node));
  const changes: Change[] = [];

  const change = (node: string, workerId: string, enabled: boolean) =>
    changes.push({
      node,
      request: create(ui.SetInstanceWorkerRequestSchema, {
        harness: request.harness,
        id: ids.toGlobal(harness, request.id),
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
    setInstanceWorkers: (request, context) =>
      settled(core, undefined, setInstanceWorkers(core, local, request, context)),
  };
}
