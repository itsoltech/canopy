import { randomUUID } from "node:crypto";
import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { qualifyId, REMOTE_APP_UPDATE } from "@canopy/domain/computers";
import { pairingRequiredReason } from "@canopy/domain/computer-presence";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { single } from "../api/routed-context.ts";
import {
  PEER_READ_TIMEOUT_MS,
  PEER_UPDATE_CHECK_TIMEOUT_MS,
  PEER_UPDATE_INSTALL_TIMEOUT_MS,
} from "../computers/timing.ts";
import { forward } from "../api/routed-home.ts";
import { ConfigIds } from "../api/routed-config.ts";
import { updatesSnapshot } from "./center-composition.ts";
import { Match } from "effect";

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

    if (input.action === "check") await core.appControl.check();
    else if (input.action === "dismiss") {
      await core.appControl.dismiss(input.requestId);
      await core.departures.recover("dismissed", "", core.appControl.snapshot().targetVersion);
    } else {
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

      if (capable) {
        const request = create(link.ComputerUpdatesRequestSchema);
        const reachable = computers.reachable().includes(peer.nodeId);

        item.updates = computers.reads.read(
          peer.nodeId,
          method,
          request,
          (signal) => single<ui.UpdatesSnapshot>(forward(core, peer.nodeId, method, request, signal)),
          PEER_READ_TIMEOUT_MS,
          reachable,
        );
        item.readState = reachable ? computers.reads.state(peer.nodeId, method, request) : "unavailable";
        // A computer that announced its own update restart is expected to be away: its row says so calmly.
        const restarting = ["updating", "restarting"].includes(peer.status);
        item.reason = Match.value(item.readState).pipe(
          Match.when("unavailable", () => (restarting ? "" : `${name} is unavailable. Trying again automatically.`)),
          Match.when("fresh", () => ""),
          Match.orElse(() => `Waiting for ${name}. Local updates are ready.`),
        );

        if (!reachable && item.updates) {
          const away = item.reason || `${name} is restarting to update.`;

          if (item.updates.app) item.updates.app.connected = false;

          for (const worker of item.updates.workers) {
            worker.connected = false;
            worker.reason = away;
          }

          for (const worker of item.updates.cliWorkers) {
            worker.online = false;

            for (const tool of worker.cliTools) tool.blockedReason = away;
          }
        }
      }

      if (peer.status === "pairing_required") item.reason = peer.unavailableReason || pairingRequiredReason(name);

      return item;
    }),
  );
}

/** The caller's side: one request to a directly linked computer that supports it, or a readable refusal at once. */
export async function requestComputerUpdate(
  core: GatewayCore,
  nodeId: string,
  action: "app" | "check" | "worker" | "dismiss",
  workerId = "",
  signal?: AbortSignal,
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
      create(link.ComputerUpdateRequestSchema, {
        action,
        workerId: action === "dismiss" ? "" : workerId,
        // The owner selected this direct peer; accept its plain UUID as well as the returned qualified ID.
        // qualifyId preserves existing suffixes, so forward still rejects an ID belonging to another computer.
        requestId: action === "dismiss" ? qualifyId(workerId, nodeId) : "",
      }),
      AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(action === "check" ? PEER_UPDATE_CHECK_TIMEOUT_MS : PEER_UPDATE_INSTALL_TIMEOUT_MS),
      ]),
    ),
  );

  // The action's authoritative result replaces cached history, including a read already in flight.
  const read = methodNamed("GetComputerUpdates")!;
  computers.reads.forget(nodeId, new Set([read.name]));
  computers.reads.remember(nodeId, read, create(link.ComputerUpdatesRequestSchema), snapshot);
  computers.reads.due(nodeId, read.name);

  if (action !== "check") await audit(core, "computer.update.sent", { node: nodeId, action, worker: workerId });

  return snapshot;
}

/** Feed checks are idempotent, single-flight background work; local Check now never waits for a peer. */
export async function checkLinkedUpdates(core: GatewayCore) {
  const computers = core.computers;

  if (!computers) return;
  const method = methodNamed("RequestComputerUpdate")!;
  const request = create(link.ComputerUpdateRequestSchema, { action: "check" });

  for (const peer of (await computers.snapshot()).peers) {
    if (
      peer.viaNodeId ||
      !computers.reachable().includes(peer.nodeId) ||
      !computers.capabilities(peer.nodeId).includes(REMOTE_APP_UPDATE)
    )
      continue;
    computers.reads.read(
      peer.nodeId,
      method,
      request,
      (signal) => requestComputerUpdate(core, peer.nodeId, "check", "", signal),
      PEER_UPDATE_CHECK_TIMEOUT_MS,
    );
  }
}

/**
 * A linked computer announced an update center change: refresh its snapshot now instead of after the read
 * cooldown. The settled read tells clients (`linked_read_completed` GetComputerUpdates) to read GetUpdates once.
 */
export function refreshComputerUpdates(core: GatewayCore, nodeId: string): void {
  const computers = core.computers;

  if (!computers?.reachable().includes(nodeId)) return;
  const method = methodNamed("GetComputerUpdates")!;
  const request = create(link.ComputerUpdatesRequestSchema);
  computers.reads.due(nodeId, method.name);
  computers.reads.read(
    nodeId,
    method,
    request,
    (signal) => single<ui.UpdatesSnapshot>(forward(core, nodeId, method, request, signal)),
    PEER_READ_TIMEOUT_MS,
  );
}
