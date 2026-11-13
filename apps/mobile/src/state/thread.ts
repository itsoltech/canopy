import { useMemo, useRef, useState } from "react";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { useSession } from "./session";
import { useStream } from "./stream";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { firstHistoryPage, useHistoryPage } from "./history-page";
import { ThreadWatchRecovery, threadWatchMessage, threadSyncStatus } from "@canopy/domain/thread-watch-recovery";
import { useThreadPersistence } from "./thread-persistence";
import { threadWatchReady } from "@canopy/domain/thread-watch-state";
import { mobileSnapshotStarted, mobileSnapshotFinished } from "../features/settings/client-diagnostics";

/** Read the durable base before subscribing; every retry uses the latest atomic checkpoint. */
export function useThreadSnapshot(id: string) {
  const { client, session } = useSession();
  const { snapshot, setSnapshot, current, loaded, reset } = useThreadPersistence(id);
  const repair = useMemo(() => new ThreadWatchRecovery(), [id, client]);
  const pageSize = useRef(24);
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
      const sampled = update.change.case === "snapshot" || update.change.case === "batch" ? mobileSnapshotStarted() : 0;

      if (update.syncStatus) setSyncStatus(update.syncStatus);

      if (update.change.case === "batch") setSyncStatus(threadSyncStatus(update.change.value));

      try {
        current.current = applyThreadUpdate(current.current, update);
      } catch {
        throw new ConnectError("Thread resynchronization required", Code.DataLoss);
      }

      setSnapshot(current.current);
      mobileSnapshotFinished(sampled);

      const caughtUp = threadWatchReady(update);

      if (caughtUp) {
        repair.advanced(current.current.syncCursor?.appliedSeq ?? 0n);

        if (!update.syncStatus?.reason && update.change.case !== "batch") setSyncStatus(undefined);
      }

      return caughtUp;
    },
    `${session?.deviceId}:${id}`,
    (error) => {
      const decision = repair.failed({
        code: error.code,
        computer: error.metadata.get("canopy-error-scope") === "computer",
      });

      if (decision.action === "reset" || decision.action === "smaller") reset();

      if (decision.action === "smaller") pageSize.current = 8;
      console.warn("Thread watch failed", { reason: decision.reason, code: error.code, action: decision.action });

      return { retry: decision.action !== "stop", issue: threadWatchMessage(decision.reason) };
    },
  );

  const history = useHistoryPage(id, {
    current,
    read: async (base, signal) => {
      if (!client) throw new Error("Gateway unavailable");

      const update = await firstHistoryPage(
        (signal) =>
          client.api.watchThread(
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
    },
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
