import { randomUUID } from "node:crypto";
import { create, ScalarType, type DescMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { connectors, ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { linkedMessage, WORKER_SETTINGS } from "../computers/remote.ts";
import { globalIds } from "../config-sync/worker-records.ts";
import type { GatewayCore } from "../core/core.ts";
import { ConfigIds } from "./routed-config.ts";
import { PLAIN, single, unaryTimeout } from "./routed-context.ts";
import { forward, peerOf } from "./routed-home.ts";

/**
 * Worker settings edited from another computer (docs/linked-computers.md, "Rekordy workerów i edycja zdalna").
 * The worker's home applies the edit with its own handlers over a link that carries configuration; nothing is
 * queued for an unreachable home. Both computers audit the edit, without values.
 */
const READ_ONLY = new Set(["GetWorktreeSettings", "GetInstanceWorker", "GetWorkerEnvironment"]);

/** The worker ids a request names at its top level (`worker_id`, `worker_ids`). */
export function workerIdsOf(desc: DescMessage, message: Message): string[] {
  const record = reflect(desc, message);
  const ids: string[] = [];

  for (const field of desc.fields) {
    if (field.name !== "worker_id" && field.name !== "worker_ids") continue;

    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING && record.get(field))
      ids.push(String(record.get(field)));
    else if (field.fieldKind === "list") for (const id of record.get(field)) ids.push(String(id));
  }

  return ids;
}

export async function refuseWithoutConfig(core: GatewayCore, node: string) {
  if (await ConfigIds.carries(core, node)) return;
  const peer = await core.computers?.store.computer(node);
  const name = peer?.display_name || peer?.name || "the other computer";

  throw new ConnectError(
    `Turn on Share configuration with “${name}” to change its workers' settings.`,
    Code.FailedPrecondition,
  );
}

export async function auditWorkerEdit(
  core: GatewayCore,
  direction: "sent" | "received",
  method: string,
  node: string,
  workers: readonly string[],
) {
  const store = core.computers?.store;

  if (!store || READ_ONLY.has(method)) return;
  const plain = workers.map((id) => splitId(id).id);

  await store.query(
    `INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
    VALUES($1::uuid,$2::uuid,$3,'worker',$4::uuid,$5::jsonb)`,
    [
      randomUUID(),
      store.owner,
      `computer.config.worker.${direction}`,
      plain.find((id) => PLAIN.test(id)) ?? null,
      JSON.stringify({ method, node, workers: plain }),
    ],
  );
}

/** A local edit of worker settings: this computer's worker records follow before the answer. */
export async function settled<A>(core: GatewayCore, method: DescMethod | undefined, response: Promise<A>): Promise<A> {
  const value = await response;

  if (!method || WORKER_SETTINGS.has(method.name)) await core.computers?.config?.publishWorkers().catch(() => false);

  return value;
}

/** A worker setting for another computer's worker: its home applies it, or the call fails at once. */
export async function sendWorkerSetting(
  core: GatewayCore,
  method: DescMethod,
  request: Message,
  ref: string,
  signal: AbortSignal,
): Promise<Message> {
  const node = await peerOf(core, ref, method, request);
  await refuseWithoutConfig(core, node);

  const response = await single(
    forward(core, node, method, request, AbortSignal.any([signal, AbortSignal.timeout(unaryTimeout(method))])),
  );

  await auditWorkerEdit(core, "sent", method.name, node, workerIdsOf(method.input, request));

  // The home's instance answers under this computer's id for it.
  if (method.name === "SetInstanceWorker") {
    const answer = linkedMessage(ui.SetInstanceWorkerResponseSchema, response);

    if (answer.instance) answer.instance.id = linkedMessage(ui.SetInstanceWorkerRequestSchema, request).id;
  }

  return response;
}

/**
 * The home's checks before a linked computer's worker setting runs: the link carries configuration, every worker is
 * this computer's, and the shared parts stay untouched. Returns an answer when the home handles the call here.
 */
export async function receiveWorkerSetting(
  core: GatewayCore,
  method: DescMethod,
  request: Message,
  peer: string,
): Promise<Message | undefined> {
  const computers = core.computers;

  if (!computers || !(await ConfigIds.carries(core, peer)))
    throw new ConnectError("Configuration sharing is off for this link", Code.FailedPrecondition);
  const ids = workerIdsOf(method.input, request);

  if (!ids.length && method.name !== "SetConnectorAccess")
    throw new ConnectError("Choose a worker on this computer", Code.InvalidArgument);

  const owned =
    ids.every((id) => PLAIN.test(id)) &&
    (
      await computers.store.query<{ id: string }>(
        "SELECT id::text FROM workers WHERE owner_user_id=$1::uuid AND archived_at IS NULL AND id=ANY($2::uuid[])",
        [computers.store.owner, ids],
      )
    ).length === new Set(ids).size;

  if (!owned) throw new ConnectError("This worker isn't on this computer", Code.PermissionDenied);

  if (method.name === "SetEnvironmentTags") {
    // One worker's tags at its home; the library revision of the caller is another computer's.
    const tags = linkedMessage(ui.SetEnvironmentTagsRequestSchema, request);
    tags.expectedRevision = (await core.environment.snapshot()).revision;
  }

  if (method.name === "SetConnectorAccess") {
    const access = linkedMessage(connectors.SetConnectorAccessRequestSchema, request);

    const local = await computers.store.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => globalIds(sql, computers.store.owner, "connector")),
    );

    return create(connectors.ConnectorAccountResponseSchema, {
      account: await core.connectors.workerAccess(local.toLocal(access.accountId), access.workerIds),
    });
  }

  return undefined;
}

/** After the home applied a linked computer's worker setting: its records follow, and the edit is audited. */
export async function receivedWorkerSetting(core: GatewayCore, method: DescMethod, request: Message, peer: string) {
  await core.computers?.config?.publishWorkers().catch(() => false);
  await auditWorkerEdit(core, "received", method.name, peer, workerIdsOf(method.input, request));
}
