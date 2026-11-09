import { type DescMethod, type Message } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import {
  AGENT_BUS,
  MOVE_ITEMS,
  RELAY,
  REMOTE_APP_UPDATE,
  REMOTE_BOTS,
  REMOTE_THREADS,
  THREAD_MIRROR,
  THREAD_MIRROR_DELTA,
  THREAD_WATCH_LIVENESS,
  THREAD_WATCH_COALESCE,
} from "@canopy/domain/computers";

import { BOT_METHODS, linkedMessage, MOVE_METHODS, UPDATE_METHODS, type RelayRoute } from "./remote.ts";

import { RELAY_METHODS, relayCallback } from "./relay.ts";

import { computersState, type Connection } from "./runtime-context.ts";
import { computersRelayChannel } from "./runtime-remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { serveConfigBlob } from "./runtime-blobs.ts";
import { serveConfig } from "./runtime-config.ts";
import { publishThreadWatch } from "./thread-watch-publish.ts";
import { ui } from "@canopy/contracts";
import { watchTiming } from "./watch-liveness.ts";

// ------------------------------------------------------------------ stage 2: remote threads

/** A direct caller may request one relay leg. Only the relay can attest an
 * origin, and an attested request can only execute at this receiving home. */
export async function* computersServeRemote(
  hostContext: LinkedComputers,
  nodeId: string,
  connection: Connection,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
  route?: RelayRoute,
): AsyncGenerator<Message> {
  if (!route?.targetNodeId) {
    if (route?.originNodeId || route?.relayHops) throw new ConnectError("Invalid relay envelope", Code.InvalidArgument);
    yield* computersServeHome(hostContext, nodeId, connection, method, request, signal);

    return;
  }

  if (
    !hostContext.hello().capabilities.includes(RELAY) ||
    !connection.capabilities?.has(RELAY) ||
    !RELAY_METHODS.has(method.name)
  )
    throw new ConnectError("This action cannot be relayed", Code.PermissionDenied);

  if (route.relayHops === 1) {
    if (
      route.targetNodeId !== hostContext[computersState].identity.node_id ||
      !/^[a-f0-9]{64}$/.test(route.originNodeId) ||
      [nodeId, hostContext[computersState].identity.node_id].includes(route.originNodeId)
    )
      throw new ConnectError("Relay hop limit reached or loop detected", Code.PermissionDenied);
    const origin = hostContext.relay.entries.get(route.originNodeId);

    if (
      !origin ||
      origin.via_node_id !== nodeId ||
      !computersRelayChannel(hostContext, nodeId) ||
      (origin.relay_role === "home" && !relayCallback(method, request))
    )
      throw new ConnectError("Origin is not shared through this relay", Code.PermissionDenied);
    yield* hostContext.relay.guard(
      () =>
        hostContext.relay.entries.get(route.originNodeId)?.via_node_id === nodeId &&
        (hostContext.relay.entries.get(route.originNodeId)?.relay_role !== "home" || relayCallback(method, request)) &&
        Boolean(computersRelayChannel(hostContext, nodeId)),
      signal,
      (s) => computersServeHome(hostContext, route.originNodeId, connection, method, request, s),
    );

    return;
  }

  if (
    route.relayHops !== 0 ||
    route.originNodeId ||
    [nodeId, hostContext[computersState].identity.node_id].includes(route.targetNodeId)
  )
    throw new ConnectError("Relay hop limit reached or loop detected", Code.PermissionDenied);
  const target = await hostContext.store.peer(route.targetNodeId);

  if (!target) throw new ConnectError("Relay targets must be direct partners (one hop)", Code.PermissionDenied);
  const callback = relayCallback(method, request);

  const feature =
    method.name === "CallAgentBus"
      ? AGENT_BUS
      : BOT_METHODS.has(method.name)
        ? REMOTE_BOTS
        : method.name === "WatchThreadMirror"
          ? THREAD_MIRROR
          : REMOTE_THREADS;

  if (!connection.capabilities?.has(feature) || !hostContext.capabilities(target.node_id).includes(feature))
    throw new ConnectError("All computers need an update for this linked action", Code.FailedPrecondition);

  const allowed = () =>
    hostContext.relay.allowed(nodeId, target.node_id) ||
    (callback && hostContext.relay.allowed(target.node_id, nodeId));

  if (!allowed()) throw new ConnectError("Share onward is not enabled for this computer", Code.PermissionDenied);
  const remote = computersRelayChannel(hostContext, target.node_id);

  if (!remote) throw await hostContext.unavailable(target.node_id);
  yield* hostContext.relay.guard(
    () =>
      allowed() &&
      Boolean(computersRelayChannel(hostContext, nodeId)) &&
      Boolean(computersRelayChannel(hostContext, target.node_id)),
    signal,
    (s) => remote.call(method, request, s, { targetNodeId: target.node_id, originNodeId: nodeId, relayHops: 1 }),
  );
}

export async function* computersServeHome(
  hostContext: LinkedComputers,
  nodeId: string,
  connection: Connection,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
): AsyncGenerator<Message> {
  if (method.name === "GetConfigBlob") {
    yield* serveConfigBlob(hostContext, nodeId, connection, linkedMessage(link.ConfigBlobRequestSchema, request));

    return;
  }

  if (method.name === "WatchConfig") {
    yield* serveConfig(hostContext, nodeId, connection, linkedMessage(link.ConfigCursorSchema, request), signal);

    return;
  }

  if (UPDATE_METHODS.has(method.name)) {
    const updates = hostContext.options.updates;

    if (
      !updates ||
      !hostContext.hello().capabilities.includes(REMOTE_APP_UPDATE) ||
      !connection.capabilities?.has(REMOTE_APP_UPDATE) ||
      hostContext.relay.entries.has(nodeId)
    )
      throw new ConnectError("Both computers need an update for remote app updates", Code.Unimplemented);
    yield await updates(nodeId, method, request);

    return;
  }

  if (!hostContext.options.serve) throw new ConnectError("Thread sharing unavailable", Code.Unimplemented);

  if (MOVE_METHODS.has(method.name)) {
    if (!hostContext.moves || !connection.capabilities?.has(MOVE_ITEMS) || hostContext.relay.entries.has(nodeId))
      throw new ConnectError("Moves need an update on both computers", Code.Unimplemented);
    yield await hostContext.moves.serve(nodeId, method, request);

    return;
  }

  // A thing that moved away answers with its new home; the caller follows (stage 8).
  hostContext.redirects.refuse(method, request);

  const feature =
    method.name === "CallAgentBus" ? AGENT_BUS : BOT_METHODS.has(method.name) ? REMOTE_BOTS : REMOTE_THREADS;

  if (!hostContext.hello().capabilities.includes(feature) || !connection.capabilities?.has(feature))
    throw new ConnectError("Both computers need an update for this linked action", Code.Unimplemented);

  if (method.name === "WatchThreadMirror") {
    if (!hostContext.hello().capabilities.includes(THREAD_MIRROR) || !connection.capabilities?.has(THREAD_MIRROR))
      throw new ConnectError("Thread mirrors need an update on both computers", Code.Unimplemented);
    const input = linkedMessage(link.MirrorRequestSchema, request);
    input.incremental &&=
      hostContext.hello().capabilities.includes(THREAD_MIRROR_DELTA) &&
      connection.capabilities.has(THREAD_MIRROR_DELTA);
    input.heartbeat &&=
      hostContext.hello().capabilities.includes(THREAD_WATCH_LIVENESS) &&
      connection.capabilities.has(THREAD_WATCH_LIVENESS);
    console.debug("Linked thread mirror subscribed", { peer: nodeId, side: "home" });

    try {
      yield* hostContext.mirror.publish(input, hostContext.options.serve, signal, watchTiming(hostContext).heartbeatMs);
    } catch (error) {
      if (!signal.aborted)
        console.warn("Linked thread mirror failed", {
          peer: nodeId,
          side: "home",
          code: ConnectError.from(error).code,
        });
      throw error;
    } finally {
      console.debug("Linked thread mirror ended", { peer: nodeId, side: "home" });
    }
  } else if (method.name === "WatchBotMirror")
    yield* hostContext.botMirror.publish(
      linkedMessage(link.MirrorRequestSchema, request),
      hostContext.options.serve,
      signal,
    );
  else if (
    method.name === "WatchThread" &&
    linkedMessage(ui.WatchThreadRequestSchema, request).watchLiveness &&
    hostContext.hello().capabilities.includes(THREAD_WATCH_LIVENESS) &&
    connection.capabilities?.has(THREAD_WATCH_LIVENESS)
  )
    yield* publishThreadWatch(
      hostContext,
      hostContext.options.serve,
      linkedMessage(ui.WatchThreadRequestSchema, request),
      signal,
      nodeId,
      linkedMessage(ui.WatchThreadRequestSchema, request).watchCoalesce &&
        hostContext.hello().capabilities.includes(THREAD_WATCH_COALESCE) &&
        Boolean(connection.capabilities?.has(THREAD_WATCH_COALESCE)),
    );
  else yield* hostContext.options.serve(method, request, signal, nodeId);
}
