import { create, type MessageInitShape } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import { AsyncChannel } from "@canopy/transport";

import { type PeerRow } from "./store.ts";

import { computersState, LAST_SEEN_WRITE_MS, type Connection } from "./runtime-context.ts";
import { computersReceive } from "./runtime-frames.ts";
import { computersAdvertise } from "./runtime-lan.ts";
import { computersEmit, computersSyncMirror } from "./runtime-mirrors.ts";
import { computersStatus } from "./runtime-remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { discoverCertificate, linkClient } from "./transport.ts";
import { refreshConfigGroup, stopConfig, syncConfig } from "./runtime-config.ts";

export function computersBroadcast(hostContext: LinkedComputers, frame: MessageInitShape<typeof link.LinkFrameSchema>) {
  for (const set of hostContext[computersState].active.values()) for (const c of set) c.send(frame);
}

export function computersTrack(hostContext: LinkedComputers, nodeId: string, connection: Connection) {
  const set = hostContext[computersState].active.get(nodeId) ?? new Set();
  set.add(connection);
  hostContext[computersState].active.set(nodeId, set);

  return async () => {
    connection.remote?.close();
    set.delete(connection);

    if (!set.size) stopConfig(hostContext, nodeId);

    if (!set.size) {
      hostContext[computersState].active.delete(nodeId);

      if (hostContext[computersState].stopped) return;
      const peer = await hostContext.store.peer(nodeId);

      if (peer && ["connected", "needs_update"].includes(peer.status))
        await computersStatus(hostContext, nodeId, "unreachable", peer.update_node_id);
      else computersEmit(hostContext, nodeId);
    } else computersEmit(hostContext, nodeId);
    hostContext.relay.check();
    await hostContext.relay.refresh();
  };
}

/**
 * Frames are handled one after another: a heartbeat must not wait for the database each time, or a slow
 * database holds up the frames behind it until the link looks dead.
 */
export async function computersHeartbeat(hostContext: LinkedComputers, nodeId: string, connection: Connection) {
  connection.seen = Date.now();

  if (connection.seen - (connection.stored ?? 0) < LAST_SEEN_WRITE_MS) return;
  connection.stored = connection.seen;

  const known = await hostContext.store.query(
    "UPDATE computer_peers SET last_seen=now() WHERE owner_user_id=$1::uuid AND node_id=$2 RETURNING node_id",
    [hostContext.store.owner, nodeId],
  );

  if (!known.length) connection.send({ body: { case: "unlinked", value: {} } });
}

/**
 * Heartbeats and dead links, on every interval and without the database: a slow tick must not silence a live
 * link. A late interval means this process stalled, and the peer's frames may still wait unread: no verdict then.
 */
export function computersPulse(hostContext: LinkedComputers) {
  const heartbeat = hostContext.options.heartbeatMs ?? 5000;
  const now = Date.now();
  const stalled = hostContext[computersState].pulsed > 0 && now - hostContext[computersState].pulsed > heartbeat * 2;
  hostContext[computersState].pulsed = now;

  if (hostContext[computersState].stopped || hostContext[computersState].paused) return;

  for (const set of hostContext[computersState].active.values())
    for (const c of set) {
      if (!stalled && now - c.seen > heartbeat * 4) c.close();
      else if (c.ready) c.send({ body: { case: "heartbeat", value: { sentAtMs: BigInt(now) } } });
    }
}

export async function computersTick(hostContext: LinkedComputers) {
  if (
    hostContext[computersState].tickRunning ||
    hostContext[computersState].stopped ||
    hostContext[computersState].paused
  )
    return;
  hostContext[computersState].tickRunning = true;

  try {
    computersAdvertise(hostContext);
    await refreshConfigGroup(hostContext);

    if (hostContext.shared && !hostContext[computersState].sharing) {
      hostContext[computersState].sharing = true;
      void hostContext.configChanged().finally(() => {
        hostContext[computersState].sharing = false;
      });
    }

    for (const peer of await hostContext.store.peers()) {
      if (hostContext[computersState].stopped || hostContext[computersState].paused) break;
      computersSyncMirror(hostContext, peer.node_id);
      syncConfig(hostContext, peer.node_id);
      const active = hostContext[computersState].active.get(peer.node_id);

      if (active?.size) continue;

      if (
        hostContext[computersState].dialing.has(peer.node_id) ||
        (hostContext[computersState].retry.get(peer.node_id)?.at ?? 0) > Date.now()
      )
        continue;
      const controller = new AbortController();
      hostContext[computersState].dialing.set(peer.node_id, controller);

      const task = computersDial(hostContext, peer, controller)
        .catch(() => {
          // Database failures must not escape the background reconnect loop.
          console.warn("Computer link reconnect failed; retrying on the next heartbeat");
        })
        .finally(() => {
          hostContext[computersState].dialing.delete(peer.node_id);
          hostContext[computersState].tasks.delete(task);
        });

      hostContext[computersState].tasks.add(task);
    }

    for (const p of hostContext.relay.entries.values()) computersSyncMirror(hostContext, p.node_id);
    await hostContext.relay.refresh();
    void hostContext.moves?.tick().catch(() => {});
  } finally {
    hostContext[computersState].tickRunning = false;
  }
}

export async function computersDial(hostContext: LinkedComputers, peer: PeerRow, controller: AbortController) {
  for (const route of await hostContext[computersState].routes.list(peer.node_id)) {
    const { address } = route;

    if (
      controller.signal.aborted ||
      hostContext[computersState].stopped ||
      hostContext[computersState].paused ||
      hostContext[computersState].active.get(peer.node_id)?.size
    )
      return;
    const output = new AsyncChannel<link.LinkFrame>();
    const routeController = new AbortController();

    const connection: Connection = {
      send: (f) => {
        output.push(create(link.LinkFrameSchema, f));
      },
      close: () => {
        output.close();
        routeController.abort();
        connection.remote?.close();
      },
      seen: Date.now(),
      ready: false,
    };

    const release = computersTrack(hostContext, peer.node_id, connection);
    let greeted = false;

    try {
      connection.send({ body: { case: "hello", value: hostContext.hello() } });
      // Queued hello is sent only after verification. No heartbeat may precede it.
      const started = performance.now();
      await discoverCertificate(address, peer.fingerprint, hostContext[computersState].identity);
      const latency = performance.now() - started;

      const deadline = setTimeout(() => {
        if (!greeted) routeController.abort();
      }, 8000);

      try {
        for await (const frame of linkClient(address, peer.certificate, hostContext[computersState].identity).connect(
          output,
          {
            signal: AbortSignal.any([controller.signal, routeController.signal]),
          },
        )) {
          if (!greeted && !["welcome", "unlinked"].includes(frame.body.case ?? ""))
            throw new ConnectError("Handshake required", Code.FailedPrecondition);

          if (!greeted && frame.body.case === "welcome") {
            if (hostContext[computersState].announced !== "connected")
              connection.send({
                body: {
                  case: "presence",
                  value: { state: hostContext[computersState].announced, announcedAtMs: BigInt(Date.now()) },
                },
              });
          }

          greeted = true;
          clearTimeout(deadline);
          await computersReceive(hostContext, peer.node_id, frame, connection);

          if (frame.body.case === "welcome")
            await hostContext[computersState].routes.success(peer.node_id, address, latency);

          if (controller.signal.aborted) break;
        }
      } finally {
        clearTimeout(deadline);
      }

      if (greeted) {
        hostContext[computersState].retry.delete(peer.node_id);
        break;
      }
    } catch (error) {
      const mismatch = error instanceof ConnectError && error.code === Code.Unauthenticated;

      // A pin mismatch never changes trust. Another device now has a discovered address: forget that path.
      // An address the user entered keeps the stage 1 meaning: the computer must be paired again.
      if (mismatch && route.source === "manual") await computersStatus(hostContext, peer.node_id, "pairing_required");

      if (mismatch && route.source === "lan") await hostContext[computersState].routes.remove(peer.node_id, address);
      else if (!greeted && !controller.signal.aborted)
        await hostContext[computersState].routes.failure(peer.node_id, address);
    } finally {
      output.close();
      await release();
    }
  }

  const delay = Math.min(30_000, (hostContext[computersState].retry.get(peer.node_id)?.delay ?? 500) * 2);
  hostContext[computersState].retry.set(peer.node_id, { delay, at: Date.now() + delay + (Math.random() * delay) / 4 });
}
