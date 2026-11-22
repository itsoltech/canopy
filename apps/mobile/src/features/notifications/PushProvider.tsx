import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useSession } from "../../state/session";
import { loadNotifications, type NativeNotifications } from "./native-push";
import { PushRegistration } from "./push-registration";

const Context = createContext<PushRegistration | null>(null);

export function PushProvider({ children }: { children: ReactNode }) {
  const { active, client, session, online, epoch, pairingSignal, rememberMobilePush } = useSession();

  const registration = useMemo(
    () =>
      client && session
        ? new PushRegistration(client.api, session.deviceId, pairingSignal, session.mobilePush, (value) =>
            rememberMobilePush(session.deviceId, value),
          )
        : null,
    [client, session, pairingSignal, rememberMobilePush],
  );

  useEffect(() => {
    if (active) registration?.refresh();
  }, [registration, active, online, epoch]);

  useEffect(() => {
    if (!registration) return;
    let live = true;
    let subscription: ReturnType<NativeNotifications["addPushTokenListener"]> | undefined;

    void loadNotifications().then((native) => {
      if (live) subscription = native?.addPushTokenListener(registration.tokenChanged);
    });

    return () => {
      live = false;
      subscription?.remove();
    };
  }, [registration]);

  return <Context.Provider value={registration}>{children}</Context.Provider>;
}

const subscribeNothing = () => () => {};
const noRegistration = () => undefined;

export function useMobilePush() {
  const registration = useContext(Context);

  const state = useSyncExternalStore(
    registration?.subscribe ?? subscribeNothing,
    registration?.snapshot ?? noRegistration,
  );

  return { state, registration };
}
