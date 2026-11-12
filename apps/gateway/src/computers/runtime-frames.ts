import { create } from "@bufbuild/protobuf";

import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import { AsyncChannel } from "@canopy/transport";

import { LAN_ROUTES, MOVE_ITEMS, RELAY } from "@canopy/domain/computers";

import { RemoteCalls } from "./remote.ts";

import { certificateIdentity, linkAddress } from "./identity.ts";

import { computersHeartbeat, computersTrack } from "./runtime-connection.ts";
import { computersState, type Connection } from "./runtime-context.ts";
import { computersEmit } from "./runtime-mirrors.ts";
import { PEER_ROUTE_ROTATION_WINDOW_MS } from "./timing.ts";
import { computersStatus } from "./runtime-remote.ts";
import { computersServeRemote } from "./runtime-serving.ts";
import type { LinkedComputers } from "./runtime.ts";
import { remoteCertificate } from "./transport.ts";
import type { PeerRow } from "./store.ts";
import { exchangeConfigSharing, receiveConfigSharing } from "./runtime-config.ts";
import { RESTART_PRESENCE } from "@canopy/domain/computer-presence";
import { linkFailure } from "./link-session.ts";
import { wireHello } from "./hello.ts";

export async function computersReceive(
  hostContext: LinkedComputers,
  nodeId: string,
  frame: link.LinkFrame,
  connection: Connection,
) {
  const body = frame.body;

  if (body.case === "heartbeat" && connection.ready) return computersHeartbeat(hostContext, nodeId, connection);

  if (body.case === "remoteRequest" || body.case === "remoteResponse" || body.case === "remoteCancel") {
    // Only after a handshake with a common protocol; the peer was verified then and unlink closes the stream.
    if (!connection.remote) throw new ConnectError("Remote calls need a compatible link", Code.FailedPrecondition);
    connection.seen = Date.now();
    connection.remote.receive(body);

    return;
  }

  if (body.case === "unlinked") {
    await hostContext.moves?.unlinked(nodeId);
    await hostContext.store.remove(nodeId, false);
    await hostContext.relay.refresh();
    computersEmit(hostContext, nodeId, true);

    for (const c of hostContext[computersState].active.get(nodeId) ?? []) c.close();
    hostContext[computersState].dialing.get(nodeId)?.abort();

    return;
  }

  const peer = await hostContext.store.peer(nodeId);

  if (!peer) {
    connection.send({ body: { case: "unlinked", value: {} } });

    return;
  }

  connection.seen = Date.now();

  if (body.case === "hello" || body.case === "welcome") {
    return await receiveHandshake(hostContext, nodeId, body, connection, peer);
  } else if (body.case === "configSharing") {
    await receiveConfigSharing(hostContext, nodeId, connection, body.value);
  } else if (body.case === "moved") {
    if (!connection.protocol || !connection.capabilities?.has(MOVE_ITEMS) || !hostContext.moves)
      throw new ConnectError("Moves need an update on both computers", Code.FailedPrecondition);

    if (body.value.items.length > 2000) throw new ConnectError("Too many redirects", Code.InvalidArgument);

    if ((await hostContext.redirects.learn(nodeId, body.value.items)).length) computersEmit(hostContext, nodeId);
  } else if (body.case === "relayCatalog") {
    if (
      !connection.protocol ||
      !connection.capabilities?.has(RELAY) ||
      !hostContext.hello().capabilities.includes(RELAY)
    )
      throw new ConnectError("Relay needs an update on both computers", Code.FailedPrecondition);
    await hostContext.relay.receive(nodeId, body.value);
    connection.relayReady = true;

    for (const p of hostContext.relay.entries.values())
      if (p.via_node_id === nodeId) computersEmit(hostContext, p.node_id);
  } else if (body.case === "presence") {
    if (!["updating", "restarting", "sleeping", "shutting_down", "connected"].includes(body.value.state))
      throw new ConnectError("Unknown presence state", Code.InvalidArgument);

    if (body.value.departure)
      hostContext.options.core?.hub.publishOverview(
        create(ui.OverviewUpdateSchema, {
          change: { case: "gatewayDeparture", value: { ...body.value.departure, nodeId } },
        }),
      );
    await computersStatus(
      hostContext,
      nodeId,
      body.value.state === "connected" && peer.update_node_id ? "needs_update" : body.value.state,
      peer.update_node_id,
    );

    for (const active of hostContext[computersState].active.get(nodeId) ?? [])
      active.remote?.presence(body.value.state);
    await hostContext.relay.refresh();
  } else if (body.case === "routes") {
    // The partner's addresses changed. Only over a negotiated link; they are routes like any other, used through the pin.
    if (!connection.protocol || body.value.addresses.length > 16)
      throw new ConnectError("Unsupported route announcement", Code.InvalidArgument);
    await hostContext[computersState].routes.announce(nodeId, body.value.addresses.map(linkAddress));
    // Authenticated route changes precede an intentional socket rotation, not a liveness failure.
    connection.retiring = true;
    setTimeout(() => {
      connection.retiring = false;
    }, PEER_ROUTE_ROTATION_WINDOW_MS).unref();
    hostContext.reads.connected(nodeId);
    hostContext[computersState].retry.delete(nodeId);
    computersEmit(hostContext, nodeId);
  } else if (body.case === "heartbeat") {
    await hostContext.store.query(
      "UPDATE computer_peers SET last_seen=now() WHERE owner_user_id=$1::uuid AND node_id=$2",
      [hostContext.store.owner, nodeId],
    );
  } else throw new ConnectError("Unsupported link message", Code.InvalidArgument);
}

export async function* computersAccept(
  hostContext: LinkedComputers,
  request: AsyncIterable<link.LinkFrame>,
  context: HandlerContext,
) {
  const remote = certificateIdentity(context.values.get(remoteCertificate));
  const peer = await hostContext.store.peer(remote.nodeId);

  if (!peer) {
    const revoked = await hostContext.store.query(
      "SELECT node_id FROM computer_revocations WHERE owner_user_id=$1::uuid AND node_id=$2",
      [hostContext.store.owner, remote.nodeId],
    );

    if (revoked.length) {
      yield create(link.LinkFrameSchema, { body: { case: "unlinked", value: {} } });

      return;
    }

    throw new ConnectError("Computer certificate is not pinned. Pair this computer first.", Code.Unauthenticated);
  }

  if (peer.fingerprint !== remote.fingerprint)
    throw new ConnectError("Computer certificate changed. Unlink and pair again.", Code.Unauthenticated);

  // A short background wake must not complete a handshake and advertise online.
  // The desktop clears this pause only after its wake grace (or an explicit unlock).
  if (hostContext[computersState].paused) return;

  const output = new AsyncChannel<link.LinkFrame>({
    maxItems: 256,
    reservedItems: 240,
    overflow: () => {
      console.warn("Computer link output overflow", { side: "listener", limit: 256 });

      return new ConnectError("Computer link fell behind", Code.ResourceExhausted);
    },
  });

  const connection: Connection = {
    write: async (f, signal) => {
      if (!(await output.write(create(link.LinkFrameSchema, f), signal)))
        throw new ConnectError("Computer link closed while sending", Code.Unavailable);
    },
    send: (f) => {
      if (!output.closed && !output.push(create(link.LinkFrameSchema, f)))
        connection.close(new ConnectError("Computer link fell behind", Code.ResourceExhausted));
    },
    close: (reason) => {
      if (reason) console.warn("Computer link closing", { side: "listener", ...linkFailure(reason) });
      output.close(reason);
      connection.remote?.close();
    },
    seen: Date.now(),
    ready: false,
  };

  const release = computersTrack(hostContext, peer.node_id, connection);
  const abort = () => output.close();
  context.signal.addEventListener("abort", abort, { once: true });

  const reader = (async () => {
    let first = true;

    try {
      for await (const frame of request) {
        if (first && frame.body.case !== "hello") throw new ConnectError("Handshake required", Code.FailedPrecondition);

        if (hostContext[computersState].stopped) break;
        first = false;
        await computersReceive(hostContext, peer.node_id, frame, connection);

        if (output.closed) break;
      }

      output.close();
    } catch (error) {
      if (!context.signal.aborted)
        console.warn("Computer link receive ended", { side: "listener", ...linkFailure(error) });
      output.close(error);
    }
  })();

  hostContext[computersState].tasks.add(reader);
  void reader.finally(() => hostContext[computersState].tasks.delete(reader));

  try {
    yield* output;
  } finally {
    output.close();
    context.signal.removeEventListener("abort", abort);
    void reader;
    await release();
  }
}

async function receiveHandshake(
  hostContext: LinkedComputers,
  nodeId: string,
  body: Extract<link.LinkFrame["body"], { case: "hello" | "welcome" }>,
  connection: Connection,
  peer: PeerRow,
): Promise<void> {
  const input = body.case === "hello" ? body.value : body.value.hello;

  if (!input) throw new ConnectError("Missing handshake", Code.InvalidArgument);
  const hello = hostContext.store.validateHello(input, nodeId);
  const local = hostContext.hello();

  const protocol =
    hello.minProtocol > 0 &&
    hello.maxProtocol >= hello.minProtocol &&
    Math.max(local.minProtocol, hello.minProtocol) <= Math.min(local.maxProtocol, hello.maxProtocol)
      ? Math.min(local.maxProtocol, hello.maxProtocol)
      : 0;

  const updateNodeId = protocol ? "" : hello.maxProtocol < local.minProtocol ? nodeId : local.nodeId;
  await hostContext.store.query(
    `UPDATE computer_peers SET name=$3,app_version=$4,min_protocol=$5,max_protocol=$6,capabilities=$7::jsonb
        WHERE owner_user_id=$1::uuid AND node_id=$2`,
    [
      hostContext.store.owner,
      nodeId,
      hello.name,
      hello.appVersion,
      hello.minProtocol,
      hello.maxProtocol,
      JSON.stringify(hello.capabilities),
    ],
  );
  await hostContext[computersState].routes.announce(nodeId, hello.addresses.map(linkAddress));
  connection.protocol = protocol;
  connection.capabilities = new Set(hello.capabilities);
  hostContext[computersState].capabilities.set(nodeId, hello.capabilities);
  hostContext[computersState].names.set(nodeId, peer.display_name || hello.name);

  if (protocol && !connection.remote)
    connection.remote = new RemoteCalls({
      send: (f) => connection.send(f),
      write: (f, signal) => connection.write(f, signal),
      serve: (method, request, signal, _, route) =>
        computersServeRemote(hostContext, nodeId, connection, method, request, signal, route),
      name: () => hostContext[computersState].names.get(nodeId) ?? "The other computer",
      allowed: async () => Boolean(await hostContext.store.peer(nodeId)),
    });

  // Queue the welcome before callers or mirror subscriptions can use this link.
  // Persisting status below can yield to a remote call while the peer still awaits its handshake.
  if (body.case === "hello") {
    connection.announced = local.addresses.join();
    connection.send({ body: { case: "welcome", value: { hello: wireHello(local), protocol, updateNodeId } } });

    if (hostContext[computersState].announced !== "connected")
      connection.send({
        body: {
          case: "presence",
          value: {
            state:
              hostContext[computersState].announced === "restarting" && !connection.capabilities?.has(RESTART_PRESENCE)
                ? "updating"
                : hostContext[computersState].announced,
            announcedAtMs: BigInt(Date.now()),
            departure: await hostContext.options.core?.departures.snapshot(),
          },
        },
      });
  }

  connection.ready = true;
  hostContext.reads.connected(nodeId);
  const addresses = hostContext[computersState].advertised;

  // Addresses that changed during the handshake were not announced: only ready links get announcements.
  if (protocol && connection.capabilities.has(LAN_ROUTES) && connection.announced !== addresses.join()) {
    connection.announced = addresses.join();
    connection.send({ body: { case: "routes", value: { addresses } } });
  }

  await exchangeConfigSharing(hostContext, nodeId, connection);
  // A successful handshake ends the failure streak, including when the
  // eventual disconnect arrives as an exception rather than a clean EOF.
  hostContext[computersState].retry.delete(nodeId);
  await computersStatus(hostContext, nodeId, protocol ? "connected" : "needs_update", updateNodeId);

  await hostContext.relay.refresh();

  // Where moved things live now, and unfinished moves with this computer (stage 8).
  if (protocol && hostContext.moves && hello.capabilities.includes(MOVE_ITEMS)) {
    if (hostContext.redirects.size)
      connection.send({ body: { case: "moved", value: { items: hostContext.redirects.list() } } });
    setTimeout(() => void hostContext.moves?.tick().catch(() => {}), 0);
  }
}
