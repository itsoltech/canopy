import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { THREAD_WATCH_LIVENESS, THREAD_WATCH_COALESCE } from "@canopy/domain/computers";
import { MIRROR_CURSOR } from "@canopy/domain/thread-mirror";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "./remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { WatchLease, watchTiming } from "./watch-liveness.ts";

function revisionChanged(checkpoint: string, revision: string) {
  const base = MIRROR_CURSOR.exec(checkpoint);
  const next = MIRROR_CURSOR.exec(revision);

  if (!next) throw new ConnectError("Invalid linked thread revision", Code.DataLoss);

  return !base || base[1] !== next[1] || BigInt(next[2]!) > BigInt(base[2]!);
}

function acceptEvent(change: ui.ThreadEventUpdate, lastSeq: bigint | undefined, coalesce: boolean) {
  if (lastSeq === undefined) throw new ConnectError("Linked thread event before snapshot", Code.DataLoss);

  if (change.seq <= lastSeq) return undefined;
  const first = change.firstSeq || change.seq;

  if (
    first !== lastSeq + 1n ||
    first > change.seq ||
    (change.firstSeq && (!coalesce || change.event?.body.case !== "itemDelta"))
  )
    throw new ConnectError("Linked thread event sequence gap", Code.DataLoss);

  return change.seq;
}

/** One supervisor per client watch; every reopen validates at the home, independently of the mirror. */
export async function* watchRemoteThread(
  computers: LinkedComputers,
  node: string,
  input: ui.WatchThreadRequest,
  signal: AbortSignal,
): AsyncGenerator<ui.ThreadUpdate> {
  const heartbeat =
    computers.hello().capabilities.includes(THREAD_WATCH_LIVENESS) &&
    computers.capabilities(node).includes(THREAD_WATCH_LIVENESS);

  const timing = watchTiming(computers);

  const coalesce =
    heartbeat &&
    computers.hello().capabilities.includes(THREAD_WATCH_COALESCE) &&
    computers.capabilities(node).includes(THREAD_WATCH_COALESCE);

  let request = create(ui.WatchThreadRequestSchema, {
    ...input,
    incremental: true,
    watchLiveness: heartbeat,
    watchCoalesce: coalesce,
  });

  let checkpoint = input.cursor || input.mirrorCursor;
  let lastSeq: bigint | undefined;
  let retried = false;
  let fromTurnId = input.fromTurnId;
  let historyVersion = input.historyVersion;

  while (!signal.aborted) {
    const lease = new WatchLease(signal, timing.timeoutMs);
    let seeded = false;
    let reason = "revision";
    let refreshing = false;
    console.debug("Linked thread watch subscribed", { peer: node, threadId: input.threadId, side: "subscriber" });

    try {
      for await (const message of computers.remote(node, ui.GatewayService.method.watchThread, request, lease.signal)) {
        lease.signal.throwIfAborted();
        const update = linkedMessage(ui.ThreadUpdateSchema, message);

        if (update.watchCursor) {
          if (!seeded) continue;
          lease.renew(timing.timeoutMs);

          if (!revisionChanged(checkpoint, update.watchCursor)) continue;
          refreshing = true;
          lease.close();
          break;
        }

        const change = update.change;

        if (change.case === "snapshot" || change.case === "delta") {
          if (change.case === "delta" && change.value.baseCursor !== (request.cursor || request.mirrorCursor))
            throw new ConnectError("Linked thread delta base gap", Code.DataLoss);
          const snapshot = change.case === "snapshot" ? change.value : change.value.snapshot;

          if (!snapshot?.thread) throw new ConnectError("Missing linked thread snapshot", Code.DataLoss);
          checkpoint = snapshot.cursor;
          lastSeq = snapshot.lastSeq;
          fromTurnId ||= snapshot.historyBeforeTurnId;
          historyVersion = snapshot.historyVersion;
          seeded = true;
          retried = false;
          lease.renew(heartbeat ? timing.timeoutMs : timing.legacyProbeMs);
        } else if (change.case === "event") {
          const seq = acceptEvent(change.value, lastSeq, coalesce);

          if (seq === undefined) continue;
          lastSeq = seq;
        }

        yield update;
      }

      if (!refreshing && !signal.aborted) throw new ConnectError("Linked thread watch ended", Code.Unavailable);
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof ConnectError ? error.code : Code.Unknown;

      const repairable = [Code.DeadlineExceeded, Code.DataLoss, Code.Unavailable, Code.Internal, Code.Unknown].includes(
        code,
      );

      if (!repairable) throw error;

      if (retried)
        throw new ConnectError("Linked thread synchronization is unavailable", Code.Unavailable, {
          "canopy-error-scope": "computer",
        });

      lease.close();
      reason =
        !heartbeat && seeded && code === Code.DeadlineExceeded
          ? "legacy_probe"
          : code === Code.DataLoss
            ? "gap"
            : "stall";

      if (reason !== "legacy_probe") {
        console.warn("Linked thread watch resynchronizing", {
          peer: node,
          threadId: input.threadId,
          reason,
          code,
          cursor: checkpoint,
          lastSeq: lastSeq?.toString(),
        });
        checkpoint = "";
        yield create(ui.ThreadUpdateSchema, { syncing: true });
      }

      retried = true;
    } finally {
      lease.close();
    }

    if (signal.aborted) return;
    console.debug("Linked thread watch resubscribing", { peer: node, threadId: input.threadId, reason });
    request = create(ui.WatchThreadRequestSchema, {
      ...input,
      incremental: true,
      watchLiveness: heartbeat,
      watchCoalesce: coalesce,
      mirrorCursor: "",
      cursor: input.incremental ? checkpoint : "",
      // Retain an expanded history window on automatic full-snapshot recovery.
      fromTurnId,
      historyVersion,
    });
  }
}
