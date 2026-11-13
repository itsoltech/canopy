import { useMemo, useRef, useState } from "react";
import { ui } from "@canopy/contracts";
import { ConnectError, type Client } from "@connectrpc/connect";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { useSession } from "./session";
import { useStream } from "./stream";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { firstHistoryPage, useHistoryPage } from "./history-page";
import {
  ThreadWatchRecovery,
  threadWatchMessage,
  threadSyncStatus,
  threadUpdateFailure,
  threadWatchFailure,
} from "@canopy/domain/thread-watch-recovery";
import { recordThreadWatchFailure } from "@canopy/domain/diagnostics";
import { useThreadPersistence } from "./thread-persistence";
import { threadWatchReady } from "@canopy/domain/thread-watch-state";
import {
  mobileSnapshotStarted,
  mobileSnapshotFinished,
  mobileCurrentVisible,
  mobileMeasurements,
} from "../features/settings/client-diagnostics";

/** Read the durable base before subscribing; every retry uses the latest atomic checkpoint. */
export function useThreadSnapshot(id: string) {
  const { client, session } = useSession();
  const { snapshot, setSnapshot, current, loaded, reset } = useThreadPersistence(id);
  const repair = useMemo(() => new ThreadWatchRecovery(), [id, client]);
  const pageSize = useRef(24);
  const computerAway = useMemo(() => ({ current: false }), [id, client]);
  const [syncStatus, setSyncStatus] = useState<ui.ThreadSyncStatus>();

  const stream = useStream(
    client && loaded
      ? (signal) =>
          client.api.watchThread(
            {
              threadId: id,
              pageSize: pageSize.current,
              sequence: true,
              syncCursor: current.current?.syncCursor,
              incremental: true,
              cursor: current.current?.cursor ?? "",
              fromTurnId: current.current?.historyBeforeTurnId ?? "",
              historyVersion: current.current?.historyVersion ?? "",
            },
            { signal },
          )
      : null,
    (update: ui.ThreadUpdate) => {
      const sampled =
        update.change.case === "snapshot" || update.change.case === "batch" ? mobileSnapshotStarted(id) : 0;

      if (update.syncStatus) {
        setSyncStatus(update.syncStatus);
        computerAway.current = update.syncStatus.reason === "computer_unreachable";
      }

      if (update.change.case === "batch") setSyncStatus(threadSyncStatus(update.change.value));

      try {
        current.current = applyThreadUpdate(current.current, update);
      } catch (cause) {
        const failure = threadUpdateFailure(cause);
        throw new ConnectError("Thread resynchronization required", failure.code, {
          "canopy-sync-reason": failure.reason ?? "decode_error",
          "canopy-frame-bytes": String(failure.frameBytes ?? 0),
        });
      }

      setSnapshot(current.current);
      mobileSnapshotFinished(sampled);

      const caughtUp = threadWatchReady(update);

      if (caughtUp) {
        computerAway.current = false;
        mobileCurrentVisible(id);
        repair.advanced(current.current.syncCursor?.appliedSeq ?? 0n);

        if (!update.syncStatus?.reason && update.change.case !== "batch") setSyncStatus(undefined);
      }

      return caughtUp;
    },
    `${session?.deviceId}:${id}`,
    (error) => {
      const failure = threadWatchFailure(
        error.code,
        error.metadata.get("canopy-sync-reason") ?? "",
        error.metadata.get("canopy-error-scope") === "computer" ||
          (error.metadata.get("canopy-stream-ended") === "true" && computerAway.current),
        Number(error.metadata.get("canopy-frame-bytes")),
      );

      const decision = repair.failed(failure);
      recordThreadWatchFailure(mobileMeasurements, failure, decision.reason);

      if (decision.action === "reset" || decision.action === "smaller") reset();

      if (decision.action === "smaller") pageSize.current = 8;
      console.warn("Thread watch failed", { reason: decision.reason, code: error.code, action: decision.action });

      return {
        retry: decision.action !== "stop",
        issue: threadWatchMessage(decision.reason),
        detail: `RPC ${failure.code} · ${decision.reason}`,
      };
    },
  );

  const history = useHistoryPage(id, {
    current,
    read: (base, signal) => readThreadPage(client?.api, id, base, signal),
    merge: prependThreadPage,
    receive: (next) => {
      current.current = next;
      setSnapshot(next);
    },
    restart: stream.retry,
  });

  return {
    snapshot,
    history,
    stream: {
      ...stream,
      ...(syncStatus?.reason && {
        connection: "error" as const,
        issue: threadWatchMessage(syncStatus.reason, syncStatus.computerName),
      }),
      retry() {
        repair.reset();
        stream.retry();
      },
      loadFromScratch() {
        reset();
        repair.reset();
        pageSize.current = 24;
        stream.retry();
      },
    },
    syncStatus,
    setSnapshot(update: (previous: ui.ThreadSnapshot | undefined) => ui.ThreadSnapshot | undefined) {
      current.current = update(current.current);
      setSnapshot(current.current);
    },
  };
}

async function readThreadPage(
  api: Client<typeof ui.GatewayService> | undefined,
  id: string,
  base: ui.ThreadSnapshot,
  signal: AbortSignal,
) {
  if (!api) throw new Error("Gateway unavailable");

  const update = await firstHistoryPage(
    (signal) =>
      api.watchThread(
        {
          threadId: id,
          pageSize: 24,
          sequence: true,
          beforeItemId: base.historyBeforeItemId,
          beforeTurnId: base.historyBeforeTurnId,
          historyVersion: base.historyVersion,
        },
        { signal },
      ),
    signal,
  );

  if (update.change.case !== "snapshot") throw new Error("History unavailable");

  return update.change.value;
}
