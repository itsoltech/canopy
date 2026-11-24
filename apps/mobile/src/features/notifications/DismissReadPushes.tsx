import { useEffect, useRef } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { useOverviewEvents } from "../../state/overview-bus";
import { useSession } from "../../state/session";
import { loadNotifications } from "./native-push";
import { pushReceiptId } from "./push-receipt";
import { useMobilePush } from "./PushProvider";

const batchSize = 100;

export function DismissReadPushes() {
  const { active, client, online, epoch, pairingSignal } = useSession();
  const { state } = useMobilePush();
  const enabled = state?.requested && !state.saving;
  const schedule = useRef<() => void>(undefined);

  useOverviewEvents(({ change }) => {
    // Read acknowledgements and answers broadcast a thread change after committing to the gateway.
    if (change.case === "mobileSnapshot" || (change.case === "thread" && !change.value.nodeId)) schedule.current?.();
  });

  useEffect(() => {
    if (!active || !client || !online || !enabled || pairingSignal.aborted) return;
    const { api } = client;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, pairingSignal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let queued = false;
    let supported = true;

    async function reconcile() {
      const native = await loadNotifications();

      if (!native || signal.aborted) return;
      const presented = await native.getPresentedNotificationsAsync();
      const identifiers = new Map<string, string[]>();

      for (const { request } of presented) {
        const receiptId = pushReceiptId(request);

        if (!receiptId) continue;
        const duplicates = identifiers.get(receiptId);

        if (duplicates) duplicates.push(request.identifier);
        else identifiers.set(receiptId, [request.identifier]);
      }

      const receipts = [...identifiers.keys()];

      for (let start = 0; start < receipts.length; start += batchSize) {
        if (signal.aborted) return;

        const { receiptIds } = await api.listDismissibleMobilePush(
          { receiptIds: receipts.slice(start, start + batchSize) },
          { signal, timeoutMs: 12_000 },
        );

        if (signal.aborted) return;

        const matching = receiptIds.flatMap((id) => identifiers.get(id) ?? []);
        await Promise.allSettled(matching.map((id) => native.dismissNotificationAsync(id)));
      }
    }

    function queue() {
      if (signal.aborted || !supported) return;
      queued = true;

      if (running || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        running = true;
        queued = false;
        void reconcile()
          .catch((error) => {
            if (ConnectError.from(error).code === Code.Unimplemented) supported = false;
          })
          .finally(() => {
            running = false;

            if (queued) queue();
          });
      }, 250);
    }

    schedule.current = queue;
    queue();

    return () => {
      controller.abort();
      clearTimeout(timer);
      schedule.current = undefined;
    };
  }, [active, client, online, epoch, pairingSignal, enabled]);

  return null;
}
