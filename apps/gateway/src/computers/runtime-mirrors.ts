import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import { REMOTE_BOTS, THREAD_MIRROR, THREAD_MIRROR_DELTA, THREAD_WATCH_LIVENESS } from "@canopy/domain/computers";

import { computersState, type ComputerChange } from "./runtime-context.ts";
import type { LinkedComputers } from "./runtime.ts";
import { WatchLease, watchTiming } from "./watch-liveness.ts";
import { linkedMessage } from "./remote.ts";

export function computersEmit(hostContext: LinkedComputers, nodeId: string, removed = false) {
  if (removed) {
    hostContext.reads.forget(nodeId);
    hostContext[computersState].names.delete(nodeId);
    hostContext[computersState].capabilities.delete(nodeId);
    hostContext[computersState].staleMirrors.delete(nodeId);
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
    const timing = watchTiming(hostContext);

    const heartbeat =
      hostContext.hello().capabilities.includes(THREAD_WATCH_LIVENESS) &&
      hostContext.capabilities(nodeId).includes(THREAD_WATCH_LIVENESS);

    const lease = new WatchLease(controller.signal, heartbeat ? timing.timeoutMs : timing.legacyProbeMs);

    try {
      const cursor = (await hostContext.mirror.state(nodeId))?.cursor ?? "";
      const method = link.ThreadMirrorService.method.watchThreadMirror;

      const updates = hostContext.remote(
        nodeId,
        method,
        create(link.MirrorRequestSchema, {
          cursor,
          heartbeat,
          incremental:
            hostContext.hello().capabilities.includes(THREAD_MIRROR_DELTA) &&
            hostContext.capabilities(nodeId).includes(THREAD_MIRROR_DELTA),
        }),
        lease.signal,
      );

      async function* guarded() {
        for await (const message of updates) {
          lease.signal.throwIfAborted();

          if (heartbeat) lease.renew(timing.timeoutMs);
          const frame = linkedMessage(link.MirrorUpdateSchema, message);

          if (!heartbeat && frame.commit) lease.renew(timing.legacyProbeMs);
          yield message;
        }
      }

      const notify = () => {
        hostContext[computersState].staleMirrors.delete(nodeId);

        for (const listener of hostContext[computersState].listeners) {
          try {
            listener({ nodeId, removed: false });
          } catch {
            /* subscriber owns its errors */
          }
        }
      };

      console.debug("Linked thread mirror subscribed", { peer: nodeId, side: "subscriber" });
      await hostContext.mirror.consume(nodeId, guarded(), notify, lease.signal, () => {
        if (hostContext[computersState].staleMirrors.has(nodeId)) notify();
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof ConnectError ? error.code : Code.Unknown;
        const scheduled = !heartbeat && code === Code.DeadlineExceeded;

        const disconnected =
          code === Code.Unavailable &&
          ((error instanceof ConnectError && error.metadata.get("canopy-link-closed") === "true") ||
            !hostContext.canCall(nodeId));

        if (!scheduled && !disconnected && !hostContext[computersState].staleMirrors.has(nodeId))
          hostContext[computersState].staleMirrors.set(nodeId, Date.now());
        const log = scheduled || disconnected ? console.debug : console.warn;
        log("Linked thread mirror resynchronizing", {
          peer: nodeId,
          reason: scheduled
            ? "legacy_probe"
            : code === Code.DataLoss
              ? "gap"
              : code === Code.DeadlineExceeded
                ? "stall"
                : "stream_error",
          code,
        });

        if ([Code.DataLoss, Code.DeadlineExceeded].includes(code)) await hostContext.mirror.clearCursor(nodeId);

        for (const listener of hostContext[computersState].listeners) {
          try {
            listener({ nodeId, removed: false });
          } catch {
            /* subscriber owns its errors */
          }
        }
      }
    } finally {
      lease.close();

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
          hostContext.reads.due(nodeId, "ListBots");

          for (const listener of hostContext[computersState].listeners) {
            try {
              listener({ nodeId, removed: false, botsChanged: true });
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
