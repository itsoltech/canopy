import { randomUUID } from "node:crypto";
import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { REMOTE_APP_UPDATE } from "@canopy/domain/computers";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { GATHER_TIMEOUT_MS, single } from "../api/routed-context.ts";
import { forward } from "../api/routed-home.ts";
import { ConfigIds } from "../api/routed-config.ts";
import { updatesSnapshot } from "./center-composition.ts";

/**
 * Updates of linked computers' Canopy apps (docs/updates.md, "Połączone komputery"). The caller sees each
 * directly linked computer's own snapshot; a request runs at that computer with its own feed, channel and
 * settings. Both computers audit it; nothing is queued for a computer that isn't connected.
 */
const PLAIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function audit(core: GatewayCore, action: string, details: Record<string, string>) {
  const store = core.computers?.store;

  await store?.query(
    `INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
    VALUES($1::uuid,$2::uuid,$3,'computer',NULL,$4::jsonb)`,
    [randomUUID(), store.owner, action, JSON.stringify(details)],
  );
}

/** This computer's own snapshot for a linked computer: its app, workers and agent CLIs, never its partners. */
export async function ownUpdates(core: GatewayCore): Promise<ui.UpdatesSnapshot> {
  const value = await updatesSnapshot(core, false);
  value.run = undefined;

  return value;
}

/** The home's side: the caller is a directly linked computer of this owner; the home checks everything again. */
export async function serveComputerUpdates(
  core: GatewayCore,
  nodeId: string,
  method: DescMethod,
  request: Message,
): Promise<Message> {
  // Ids of shared items travel as global ids, like other linked calls (routed.ts remoteServe).
  const ids = await ConfigIds.for(core, nodeId);
  await ids.map(method.input, request, "toLocal", true);

  if (method.name === "RequestComputerUpdate") {
    const input = linkedMessage(link.ComputerUpdateRequestSchema, request);
    const peer = await core.computers?.store.peer(nodeId);

    if (!peer) throw new ConnectError("That computer is no longer linked", Code.PermissionDenied);

    if (input.action === "check") core.appControl.check();
    else {
      if ((await core.updateCenter.status())?.state === "running")
        throw new ConnectError(
          "Update all is running on this computer. Try again when it ends.",
          Code.FailedPrecondition,
        );

      if (input.action === "app") await core.appControl.request({ nodeId, name: peer.display_name || peer.name });
      else if (input.action === "worker") {
        const own = (await ownUpdates(core)).workers.find((w) => w.workerId === input.workerId);

        if (!PLAIN.test(input.workerId) || !own || own.bundled || own.installKind !== "binary")
          throw new ConnectError("Choose a binary worker on that computer", Code.InvalidArgument);
        await core.updates.manage(create(ui.ManageUpdatesRequestSchema, { action: "worker", workerId: own.workerId }));
      } else throw new ConnectError("Unknown update action", Code.InvalidArgument);
      await audit(core, "computer.update.received", { node: nodeId, action: input.action, worker: input.workerId });
    }
  }

  const snapshot = await ownUpdates(core);
  await ids.map(ui.UpdatesSnapshotSchema, snapshot, "toGlobal");

  return snapshot;
}

/** Every linked computer with its app version and presence; directly linked ones that support it, with their updates. */
export async function linkedUpdates(core: GatewayCore): Promise<ui.ComputerUpdate[]> {
  const computers = core.computers;

  if (!computers) return [];
  const own = computers.hello().capabilities.includes(REMOTE_APP_UPDATE);
  const method = methodNamed("GetComputerUpdates")!;
  const peers = (await computers.snapshot()).peers.filter((p) => !p.relayOrigin);

  return Promise.all(
    peers.map(async (peer) => {
      const name = peer.displayName || peer.name;
      const capable = own && !peer.viaNodeId && computers.capabilities(peer.nodeId).includes(REMOTE_APP_UPDATE);

      const item = create(ui.ComputerUpdateSchema, {
        nodeId: peer.nodeId,
        name,
        version: peer.appVersion,
        presence: peer.status,
        presenceSinceMs: peer.statusSinceMs,
        remoteUpdate: capable,
        reason: capable ? "" : `Update ${name} on that computer.`,
      });

      if (capable && computers.reachable().includes(peer.nodeId))
        item.updates = await single<ui.UpdatesSnapshot>(
          forward(
            core,
            peer.nodeId,
            method,
            create(link.ComputerUpdatesRequestSchema),
            AbortSignal.timeout(GATHER_TIMEOUT_MS),
          ),
        ).catch(() => undefined);

      return item;
    }),
  );
}

/** The caller's side: one request to a directly linked computer that supports it, or a readable refusal at once. */
export async function requestComputerUpdate(
  core: GatewayCore,
  nodeId: string,
  action: "app" | "check" | "worker",
  workerId = "",
): Promise<ui.UpdatesSnapshot> {
  const computers = core.computers;

  if (!computers)
    throw new ConnectError("Linked computers are available only in the Canopy desktop app", Code.FailedPrecondition);
  const peer = await computers.store.peer(nodeId);

  if (!peer) throw new ConnectError("That computer is no longer linked", Code.NotFound);
  const name = peer.display_name || peer.name;

  if (
    !computers.hello().capabilities.includes(REMOTE_APP_UPDATE) ||
    !computers.capabilities(nodeId).includes(REMOTE_APP_UPDATE)
  )
    throw new ConnectError(`Update ${name} on that computer.`, Code.FailedPrecondition);

  if (!computers.reachable().includes(nodeId)) throw await computers.unavailable(nodeId);

  const snapshot = await single<ui.UpdatesSnapshot>(
    forward(
      core,
      nodeId,
      methodNamed("RequestComputerUpdate")!,
      create(link.ComputerUpdateRequestSchema, { action, workerId }),
      AbortSignal.timeout(30_000),
    ),
  );

  if (action !== "check") await audit(core, "computer.update.sent", { node: nodeId, action, worker: workerId });

  return snapshot;
}
