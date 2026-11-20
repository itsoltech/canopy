import { useMemo, useRef, useState } from "react";
import { equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { useSession } from "./session";
import { useStream } from "./stream";
import { useThreadHistoryPage } from "./thread-history";
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
import { useThreadLiveness } from "./thread-liveness";
import {
  mobileSnapshotStarted,
  mobileSnapshotFinished,
  mobileCurrentVisible,
  mobileMeasurements,
} from "../features/settings/client-diagnostics";

/** Read the durable base before subscribing; every retry uses the latest atomic checkpoint. */
export function useThreadSnapshot(id: string) {
  const { client, session } = useSession();
  const persistence = useThreadPersistence(id);
  const { snapshot, setSnapshot, current, view, loaded, reset } = persistence;
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

      if (update.syncStatus) computerAway.current = update.syncStatus.reason === "computer_unreachable";

      const status = update.change.case === "batch" ? threadSyncStatus(update.change.value) : update.syncStatus;

      if (status)
        setSyncStatus((previous) =>
          previous && equals(ui.ThreadSyncStatusSchema, previous, status) ? previous : status,
        );

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

      failure.transport =
        [4, 14].includes(error.code) &&
        !error.metadata.has("canopy-sync-reason") &&
        error.metadata.get("canopy-error-scope") !== "thread" &&
        error.metadata.get("canopy-stream-ended") !== "true";
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

  const connection = syncStatus?.reason ? "error" : stream.connection;
  useThreadLiveness(id, () => current.current?.syncCursor, connection, stream.retry);

  const history = useThreadHistoryPage(id, client?.api, persistence, stream.retry);

  return {
    snapshot,
    view,
    history,
    stream: {
      ...stream,
      connection,
      ...(syncStatus?.reason && {
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
