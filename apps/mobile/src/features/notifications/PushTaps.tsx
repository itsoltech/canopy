import { useEffect, useEffectEvent, useRef, useState } from "react";
import { router, useRootNavigationState } from "expo-router";
import { isEntityId } from "@canopy/domain/computers";
import { isString } from "@canopy/domain/json";
import type { ui } from "@canopy/contracts";
import type { NotificationResponse } from "expo-notifications";
import { useAppearance } from "../../state/appearance";
import { useSession } from "../../state/session";
import { loadNotifications, type NativeNotifications } from "./native-push";
import { useMobilePush } from "./PushProvider";

const receiptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PushTaps() {
  const { state } = useMobilePush();

  return <PushTapListener key={state?.requested ? "on" : "off"} />;
}

/** One path for notification responses from cold start and a running app. */
function PushTapListener() {
  const { active, client, online, pairingSignal } = useSession();
  const { threadsEnabled, botsEnabled } = useAppearance();
  const { state } = useMobilePush();
  const rootKey = useRootNavigationState()?.key;
  const [receiptId, setReceiptId] = useState<string>();
  const lastReceipt = useRef<string>(undefined);

  const receive = useEffectEvent((native: NativeNotifications, response: NotificationResponse) => {
    native.clearLastNotificationResponse();

    if (!client || pairingSignal.aborted || !state?.requested || state.saving) return;

    if (response.actionIdentifier !== native.DEFAULT_ACTION_IDENTIFIER) return;
    const id: unknown = response.notification.request.content.data?.receiptId;

    if (!isString(id) || !receiptPattern.test(id) || id === lastReceipt.current) return;
    lastReceipt.current = id;
    setReceiptId(id);
  });

  const open = useEffectEvent((destination: ui.ResolveMobilePushResponse["destination"]) => {
    if (
      !state?.requested ||
      state.saving ||
      pairingSignal.aborted ||
      !destination.case ||
      !isEntityId(destination.value)
    )
      return;
    const params = { id: destination.value };

    if (destination.case === "threadId" && threadsEnabled) router.navigate({ pathname: "/thread/[id]", params });

    if (destination.case === "botId" && botsEnabled) router.navigate({ pathname: "/bot/[id]", params });
  });

  useEffect(() => {
    let listening = true;
    let subscription: ReturnType<NativeNotifications["addNotificationResponseReceivedListener"]> | undefined;

    void loadNotifications().then((native) => {
      if (!listening || !native) return;
      subscription = native.addNotificationResponseReceivedListener((response) => receive(native, response));
      const last = native.getLastNotificationResponse();

      if (last) receive(native, last);
    });

    return () => {
      listening = false;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (!receiptId || !client || !active || !online || !rootKey || pairingSignal.aborted || !state?.requested) return;
    const request = new AbortController();
    const removePairing = () => request.abort();
    pairingSignal.addEventListener("abort", removePairing, { once: true });

    void client.api
      .resolveMobilePush({ receiptId }, { signal: request.signal, timeoutMs: 12_000 })
      .then(({ destination }) => {
        if (!request.signal.aborted) open(destination);
      })
      .catch(() => {})
      .finally(() => {
        if (!request.signal.aborted) setReceiptId((current) => (current === receiptId ? undefined : current));
      });

    return () => {
      request.abort();
      pairingSignal.removeEventListener("abort", removePairing);
    };
  }, [active, client, online, pairingSignal, receiptId, rootKey, state?.requested]);

  return null;
}
