import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import { REMOTE_BOTS, THREAD_MIRROR } from "@canopy/domain/computers";

import { computersState, type ComputerChange } from "./runtime-context.ts";
import type { LinkedComputers } from "./runtime.ts";

export function computersEmit(hostContext: LinkedComputers, nodeId: string, removed = false) {
  if (removed) {
    hostContext[computersState].names.delete(nodeId);
    hostContext[computersState].capabilities.delete(nodeId);
  }

  for (const listener of hostContext[computersState].listeners) {
    try {
      listener({ nodeId, removed });
    } catch {
      /* a subscriber's failure is its own */
    }
  }

  computersSyncMirror(hostContext, nodeId);

  // A relay's own reachability is part of every indirect computer's presence.
  for (const p of hostContext.relay.entries.values())
    if (p.via_node_id === nodeId) {
      for (const listener of hostContext[computersState].listeners) {
        try {
          listener({ nodeId: p.node_id, removed: false });
        } catch {
          /* subscriber owns errors */
        }
      }

      computersSyncMirror(hostContext, p.node_id);
    }

  hostContext.relay.check();
}

export function computersSyncMirror(hostContext: LinkedComputers, nodeId: string) {
  computersSyncBotMirror(hostContext, nodeId);

  const enabled =
    !hostContext[computersState].stopped &&
    hostContext.hello().capabilities.includes(THREAD_MIRROR) &&
    hostContext.capabilities(nodeId).includes(THREAD_MIRROR) &&
    hostContext.reachable().includes(nodeId);

  if (!enabled) {
    hostContext[computersState].mirroring.get(nodeId)?.abort();

    return;
  }

  if (hostContext[computersState].mirroring.has(nodeId)) return;
  const controller = new AbortController();
  hostContext[computersState].mirroring.set(nodeId, controller);

  const task = (async () => {
    try {
      const cursor = (await hostContext.mirror.state(nodeId))?.cursor ?? "";
      const method = link.ThreadMirrorService.method.watchThreadMirror;
      await hostContext.mirror.consume(
        nodeId,
        hostContext.remote(nodeId, method, create(link.MirrorRequestSchema, { cursor }), controller.signal),
        () => {
          for (const listener of hostContext[computersState].listeners) {
            try {
              listener({ nodeId, removed: false });
            } catch {
              /* subscriber owns its errors */
            }
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted && error instanceof ConnectError && error.code === Code.DataLoss)
        await hostContext.mirror.clearCursor(nodeId);
    } finally {
      if (hostContext[computersState].mirroring.get(nodeId) === controller)
        hostContext[computersState].mirroring.delete(nodeId);
    }
  })();

  hostContext[computersState].tasks.add(task);
  // A failed cursor write can reject during shutdown too. Observe both outcomes
  // without creating an unhandled rejected promise from finally().
  void task.then(
    () => hostContext[computersState].tasks.delete(task),
    () => hostContext[computersState].tasks.delete(task),
  );
}

export function computersSyncBotMirror(hostContext: LinkedComputers, nodeId: string) {
  const enabled =
    !hostContext[computersState].stopped &&
    hostContext.hello().capabilities.includes(REMOTE_BOTS) &&
    hostContext.capabilities(nodeId).includes(REMOTE_BOTS) &&
    hostContext.reachable().includes(nodeId);

  if (!enabled) {
    hostContext[computersState].botMirroring.get(nodeId)?.abort();

    return;
  }

  if (hostContext[computersState].botMirroring.has(nodeId)) return;
  const controller = new AbortController();
  hostContext[computersState].botMirroring.set(nodeId, controller);

  const task = (async () => {
    try {
      const cursor = await hostContext.botMirror.cursor(nodeId);
      await hostContext.botMirror.consume(
        nodeId,
        hostContext.remote(
          nodeId,
          link.LinkedAgentsService.method.watchBotMirror,
          create(link.MirrorRequestSchema, { cursor }),
          controller.signal,
        ),
        () => {
          for (const listener of hostContext[computersState].listeners) {
            try {
              listener({ nodeId, removed: false });
            } catch {
              /* subscriber owns errors */
            }
          }
        },
        controller.signal,
      );
    } catch {
      /* reconnect resumes from the last atomic checkpoint */
    } finally {
      if (hostContext[computersState].botMirroring.get(nodeId) === controller)
        hostContext[computersState].botMirroring.delete(nodeId);
    }
  })();

  hostContext[computersState].tasks.add(task);
  void task.then(
    () => hostContext[computersState].tasks.delete(task),
    () => hostContext[computersState].tasks.delete(task),
  );
}

export interface ComputersMirrorsMethods {
  subscribe(listener: (change: ComputerChange) => void): () => void;
}

export const computersMirrorsMethods: ComputersMirrorsMethods = {
  subscribe(this: LinkedComputers, listener: (change: ComputerChange) => void) {
    this[computersState].listeners.add(listener);

    return () => {
      this[computersState].listeners.delete(listener);
    };
  },
};
