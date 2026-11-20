import { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";
import { mergeThreadHistoryPage } from "@canopy/domain/history-pages";
import { firstHistoryPage, useHistoryPage } from "./history-page";
import type { useThreadPersistence } from "./thread-persistence";

export function useThreadHistoryPage(
  id: string,
  api: Client<typeof ui.GatewayService> | undefined,
  { current, setSnapshot, reset }: ReturnType<typeof useThreadPersistence>,
  restart: () => void,
) {
  return useHistoryPage(id, {
    current,
    read: (base, signal) => readThreadPage(api, id, base, signal),
    apply(base, live, page) {
      let merged: ReturnType<typeof mergeThreadHistoryPage>;

      try {
        merged = mergeThreadHistoryPage(base, live, page);
      } catch {
        reset();
        restart();

        return;
      }

      current.apply(merged.snapshot);
      setSnapshot(merged.snapshot);

      if (merged.resume) restart();
    },
  });
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

  const page = update.change.value;

  if (
    !page.historyReset &&
    page.historyVersion === base.historyVersion &&
    (page.historyHasMore || page.historyItemsHasMore) &&
    page.historyBeforeTurnId === base.historyBeforeTurnId &&
    page.historyBeforeItemId === base.historyBeforeItemId
  )
    throw new Error("History page did not advance");

  return page;
}
