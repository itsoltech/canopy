import { useEffect, useMemo } from "react";
import { botBadgeCount, maxNotificationBadge, threadBadgeCount } from "@canopy/domain/notification-badge";
import { AppState } from "react-native";
import { useAppearance } from "../../state/appearance";
import { useBotList } from "../../state/bot-list";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { setIconBadge } from "./native-push";
import { useMobilePush } from "./PushProvider";

/** iOS uses the same paired gateway for the foreground count and background push delivery. */
export function AppIconBadge() {
  const { ready, session, active, epoch, pairingSignal } = useSession();
  const { state } = useMobilePush();
  const { threadsEnabled, botsEnabled, modulesReady } = useAppearance();
  const { threads, loaded, stream } = useOverview();
  const list = useBotList();
  const requested = state?.requested;
  const deviceId = session?.deviceId;

  const unreadThreads = useMemo(
    () => (threadsEnabled ? threadBadgeCount(new Map(threads.map((thread) => [thread.id, thread])), true) : 0),
    [threads, threadsEnabled],
  );

  const unreadBots = useMemo(
    () => (botsEnabled && list.data ? botBadgeCount(list.data.bots, true) : 0),
    [botsEnabled, list.data],
  );

  const synced =
    modulesReady && loaded && stream.connection === "live" && (!botsEnabled || (!!list.data && !list.stale));

  const count = requested && synced ? Math.min(unreadThreads + unreadBots, maxNotificationBadge) : undefined;

  useEffect(() => {
    if (!ready || !active) return;

    if (!deviceId || requested === false) {
      void setIconBadge(0);

      return;
    }

    if (count === undefined) return;
    let current = true;

    void setIconBadge(count, () => current && !pairingSignal.aborted && AppState.currentState === "active");

    return () => {
      current = false;
    };
  }, [active, count, deviceId, epoch, pairingSignal, ready, requested]);

  return null;
}
