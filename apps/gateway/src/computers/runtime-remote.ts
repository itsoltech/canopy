import { type DescMethod, type Message } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { ui } from "@canopy/contracts";

import {
  AGENT_BUS,
  CONFIG_SYNC,
  NODE_REF_LENGTH,
  RELAY,
  REMOTE_BOTS,
  REMOTE_THREADS,
  THREAD_MIRROR,
} from "@canopy/domain/computers";

import { BOT_METHODS } from "./remote.ts";

import { RELAY_METHODS, relayCallback } from "./relay.ts";

import { type PeerRow } from "./store.ts";

import { type RouteRow } from "./routes.ts";

import { computersBroadcast, computersTick } from "./runtime-connection.ts";
import { computersState, ms, peerMessage, STATE_TEXT } from "./runtime-context.ts";
import { computersEmit } from "./runtime-mirrors.ts";
import type { LinkedComputers } from "./runtime.ts";
import { alternativeConfigPath, configAllowed, stopConfig } from "./runtime-config.ts";

export async function computersStatus(hostContext: LinkedComputers, nodeId: string, status: string, updateNodeId = "") {
  await hostContext.store.status(nodeId, status, updateNodeId);
  computersEmit(hostContext, nodeId);
}

export function computersChannel(hostContext: LinkedComputers, nodeId: string) {
  for (const c of hostContext[computersState].active.get(nodeId) ?? [])
    if (c.ready && c.protocol && c.capabilities?.has(REMOTE_THREADS) && c.remote && !c.remote.closed) return c.remote;

  return undefined;
}

export function computersRelayChannel(hostContext: LinkedComputers, nodeId: string) {
  if (!hostContext.hello().capabilities.includes(RELAY)) return undefined;

  for (const c of hostContext[computersState].active.get(nodeId) ?? [])
    if (c.ready && c.protocol && c.relayReady && c.capabilities?.has(RELAY) && c.remote && !c.remote.closed)
      return c.remote;

  return undefined;
}

export async function computersComputerMessage(hostContext: LinkedComputers, peer: PeerRow, routes: RouteRow[] = []) {
  const result = peerMessage(peer, hostContext.capabilities(peer.node_id), routes);
  result.shareOnwardNodeIds = hostContext.relay.selected(peer.node_id);
  result.shareConfig = peer.share_config;
  result.peerShareConfig = peer.peer_share_config;
  result.configClockAheadMinutes = hostContext.config?.ahead.get(peer.node_id) ?? 0;

  if (!peer.via_node_id) result.configAlternativeName = await alternativeConfigPath(hostContext, peer.node_id);
  computersConnectionState(hostContext, result);
  // The same negotiation as the link: each side's advertised features. This computer is named first when both lack it.
  result.configUpdateNodeId = !hostContext.hello().capabilities.includes(CONFIG_SYNC)
    ? hostContext.hello().nodeId
    : !peer.capabilities.includes(CONFIG_SYNC)
      ? peer.node_id
      : "";
  result.configSyncStatus = result.configUpdateNodeId
    ? "needs_update"
    : !peer.share_config || !peer.peer_share_config
      ? "off"
      : !configAllowed(hostContext, peer.node_id)
        ? "unreachable"
        : hostContext.config?.syncing.get(peer.node_id) !== false
          ? "syncing"
          : "up_to_date";

  if (peer.via_node_id) {
    const via = await hostContext.store.peer(peer.via_node_id);
    result.viaNodeId = peer.via_node_id;
    result.viaName = via?.display_name || via?.name || "the relay";
    result.relayOrigin = peer.relay_role === "origin";

    if (!computersRelayChannel(hostContext, peer.via_node_id)) {
      result.status = via?.status === "connected" ? "unreachable" : via?.status || "unreachable";
      result.statusSinceMs = via ? ms(via.status_since) : result.statusSinceMs;
      result.unavailableReason =
        via?.status === "connected"
          ? `Available through ${result.viaName}, which is reconnecting.`
          : `Available through ${result.viaName}, which is unreachable since ${await computersTime(hostContext, new Date(Number(result.statusSinceMs)))}`;
    }
  }

  return result;
}

/** Which side dialled the live link, and the route an outgoing link runs over. */
function computersConnectionState(hostContext: LinkedComputers, result: ui.LinkedComputer) {
  const ready = [...(hostContext[computersState].active.get(result.nodeId) ?? [])].filter((c) => c.ready);
  const outgoing = new Set(ready.flatMap((c) => (c.route ? [c.route] : [])));
  const incoming = ready.some((c) => !c.route);
  result.connectionDirection =
    outgoing.size && incoming ? "both" : outgoing.size ? "outgoing" : incoming ? "incoming" : "";

  for (const route of result.routes) route.inUse = outgoing.has(route.address);
}

export async function computersTime(hostContext: LinkedComputers, since: Date) {
  const zone = (await hostContext.options.zone?.().catch(() => undefined)) || "UTC";

  const today =
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(since) ===
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());

  return new Intl.DateTimeFormat("en", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    ...(!today && { day: "numeric", month: "short" }),
  }).format(since);
}

export interface ComputersRemoteMethods {
  capabilities(nodeId: string): string[];
  reachable(): string[];
  canCall(nodeId: string): boolean;
  computer(nodeId: string): Promise<ui.LinkedComputer | undefined>;
  resolve(ref: string): Promise<PeerRow>;
  remote(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message>;
  unavailable(nodeId: string): Promise<ConnectError>;
  announce(state: string): Promise<void>;
  close(state?: string): Promise<void>;
}

export const computersRemoteMethods: ComputersRemoteMethods = {
  /** Live features, or the last handshake persisted for offline mirror reads. */
  capabilities(this: LinkedComputers, nodeId: string): string[] {
    const indirect = this.relay.entries.get(nodeId);

    if (indirect) return indirect.capabilities;
    const all = new Set<string>();

    for (const c of this[computersState].active.get(nodeId) ?? [])
      if (c.ready && c.protocol) for (const name of c.capabilities ?? []) all.add(name);

    return all.size ? [...all] : (this[computersState].capabilities.get(nodeId) ?? []);
  },

  /** Peers whose threads this computer can show and act on right now. */
  reachable(this: LinkedComputers): string[] {
    return [...this[computersState].active.keys(), ...this.relay.entries.keys()].filter(
      (id) => this.canCall(id) && this.relay.entries.get(id)?.relay_role !== "origin",
    );
  },

  /** Includes callback-only origins for the agent bus's existing call references. */
  canCall(this: LinkedComputers, nodeId: string): boolean {
    const p = this.relay.entries.get(nodeId);

    if (!p) return Boolean(computersChannel(this, nodeId));

    return p.status === "connected" && Boolean(p.via_node_id && computersRelayChannel(this, p.via_node_id));
  },

  async computer(this: LinkedComputers, nodeId: string) {
    const peer = await this.store.computer(nodeId);

    return peer && computersComputerMessage(this, peer);
  },

  /** The linked computer of a qualified id's suffix. */
  async resolve(this: LinkedComputers, ref: string): Promise<PeerRow> {
    const peers =
      ref.length === NODE_REF_LENGTH
        ? (await this.store.computers()).filter((p) => p.relay_role !== "origin" && p.node_id.startsWith(ref))
        : [];

    if (peers.length !== 1) throw new ConnectError("That computer is no longer linked", Code.NotFound);

    return peers[0]!;
  },

  /** One call on a peer's home threads. Fails at once when it cannot be delivered; nothing waits for a reconnect. */
  async *remote(
    this: LinkedComputers,
    nodeId: string,
    method: DescMethod,
    request: Message,
    signal: AbortSignal,
  ): AsyncGenerator<Message> {
    const indirect = this.relay.entries.get(nodeId);

    if (indirect) {
      if (!RELAY_METHODS.has(method.name) || (indirect.relay_role === "origin" && !relayCallback(method, request)))
        throw new ConnectError("This relay entry is read only", Code.PermissionDenied);
      const remote = indirect.via_node_id && computersRelayChannel(this, indirect.via_node_id);

      if (!remote || !this.canCall(nodeId)) throw await this.unavailable(nodeId);

      const feature =
        method.name === "CallAgentBus"
          ? AGENT_BUS
          : BOT_METHODS.has(method.name)
            ? REMOTE_BOTS
            : method.name === "WatchThreadMirror"
              ? THREAD_MIRROR
              : REMOTE_THREADS;

      if (!this.hello().capabilities.includes(feature) || !indirect.capabilities.includes(feature))
        throw new ConnectError("The linked computer needs an update for this action", Code.FailedPrecondition);
      yield* this.relay.guard(
        () =>
          this.relay.entries.get(nodeId)?.via_node_id === indirect.via_node_id &&
          this.relay.entries.get(nodeId)?.relay_role === indirect.relay_role &&
          this.canCall(nodeId),
        signal,
        (s) => remote.call(method, request, s, { targetNodeId: nodeId, originNodeId: "", relayHops: 0 }),
      );

      return;
    }

    const remote = computersChannel(this, nodeId);

    if (!remote) throw await this.unavailable(nodeId);
    const feature = method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : undefined;

    if (feature && (!this.hello().capabilities.includes(feature) || !this.capabilities(nodeId).includes(feature))) {
      const peer = await this.store.peer(nodeId);
      throw new ConnectError(
        `${peer?.display_name || peer?.name || "The other computer"} needs an update for linked bots and agents`,
        Code.FailedPrecondition,
      );
    }

    yield* remote.call(method, request, signal);
  },

  /** Why a peer's threads cannot be reached, in the words the UI shows. */
  async unavailable(this: LinkedComputers, nodeId: string): Promise<ConnectError> {
    const peer = await this.store.computer(nodeId);

    if (!peer) return new ConnectError("That computer is no longer linked", Code.NotFound);

    if (peer.via_node_id && !computersRelayChannel(this, peer.via_node_id)) {
      const computer = await computersComputerMessage(this, peer);

      return new ConnectError(computer.unavailableReason, Code.Unavailable);
    }

    const name = peer.display_name || peer.name;

    if (peer.status === "needs_update")
      return new ConnectError(
        peer.update_node_id === this[computersState].identity.node_id
          ? `This computer needs an update to work with ${name}`
          : `${name} needs an update`,
        Code.FailedPrecondition,
      );

    if (peer.status === "connected") {
      return this.capabilities(nodeId).length && !this.capabilities(nodeId).includes(REMOTE_THREADS)
        ? new ConnectError(`${name} needs an update to share its threads`, Code.FailedPrecondition)
        : new ConnectError(`${name} is reconnecting. Try again in a moment.`, Code.Unavailable);
    }

    if (peer.status === "pairing_required")
      return new ConnectError(`${name} must be paired again`, Code.FailedPrecondition);
    const time = await computersTime(this, new Date(peer.status_since));

    return new ConnectError(
      `${name} ${STATE_TEXT.get(peer.status) ?? "is unreachable"} ${peer.status === "unreachable" || peer.status === "updating" ? "since" : "at"} ${time}`,
      Code.Unavailable,
    );
  },

  async announce(this: LinkedComputers, state: string) {
    if (!["updating", "sleeping", "shutting_down", "connected"].includes(state))
      throw new ConnectError("Unknown presence state", Code.InvalidArgument);
    this[computersState].announced = state;
    computersBroadcast(this, { body: { case: "presence", value: { state, announcedAtMs: BigInt(Date.now()) } } });
    // Allow queued control frames to reach the socket before a lifecycle stop.
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (state === "sleeping") this[computersState].paused = true;

    if (state === "connected") {
      this[computersState].paused = false;
      await computersTick(this);
    }
  },

  async close(this: LinkedComputers, state = "shutting_down") {
    if (this[computersState].stopped) return;
    this[computersState].stopped = true;
    // No move starts settling while the presence goes out: a stopping computer only finishes what runs.
    const moves = this.moves?.close();
    await this.announce(
      state === "shutting_down" && this[computersState].announced === "updating" ? "updating" : state,
    );
    clearInterval(this[computersState].timer);
    this.relay.close();
    await this[computersState].lan?.close();
    this[computersState].lan = undefined;

    for (const controller of this[computersState].dialing.values()) controller.abort();

    for (const controller of this[computersState].mirroring.values()) controller.abort();

    for (const controller of this[computersState].botMirroring.values()) controller.abort();

    for (const node of this[computersState].active.keys()) stopConfig(this, node);

    for (const set of this[computersState].active.values()) for (const c of set) c.close();
    this[computersState].unsubscribe?.();
    this[computersState].workerRecords?.();
    this.options.network.mount("link", undefined);
    await moves;
    await Promise.allSettled(this[computersState].tasks);
  },
};
