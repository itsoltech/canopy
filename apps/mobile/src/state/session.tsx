import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useNetworkState } from "expo-network";
import { routedMobileClient } from "../api/routes";
import { pinnedTransport } from "../api/pinned";
import { SessionPersistence, type DeviceSession } from "../storage/session";
import { prepareThreadCache } from "../storage/thread-cache-native";
import { clearPairingCache, type PersistentThreadCache } from "../storage/thread-cache";

function useSessionState() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [ready, setReady] = useState(false);
  const [threadCache, setThreadCache] = useState<PersistentThreadCache | null>(null);
  const [error, setError] = useState("");
  const [persistence] = useState(() => new SessionPersistence());
  const [active, setActive] = useState(AppState.currentState !== "background");
  const network = useNetworkState();
  useEffect(() => {
    void persistence
      .load()
      .then(async (value) => {
        setThreadCache(await prepareThreadCache(value));
        setSession(value);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not read secure storage. Pair this phone again."),
      )
      .finally(() => setReady(true));
  }, [persistence]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));

    return () => sub.remove();
  }, []);

  const client = useMemo(
    () =>
      session
        ? routedMobileClient({
            connection: session,
            token: session.token,
            transport: pinnedTransport,
            changed(connection) {
              void persistence
                .update(session.deviceId, connection)
                .catch(() => setError("Could not save the latest network addresses. Reconnect and try again."));
            },
          })
        : null,
    [session, persistence],
  );

  return {
    session,
    client,
    threadCache,
    ready,
    error,
    active,
    // A private tailnet gateway may be reachable even when public internet probes fail.
    online: network.isConnected !== false,
    async pair(value: DeviceSession) {
      await threadCache?.close();
      const cache = await prepareThreadCache(value);
      await persistence.save(value);
      setThreadCache(cache);
      setSession(value);
      setError("");
    },
    async forget() {
      const cleared = await clearPairingCache(threadCache, () => persistence.forget());
      setThreadCache(null);
      setSession(null);
      setError(cleared ? "" : "Could not clear local storage. Clear Canopy’s app data before pairing again.");
    },
    async expired() {
      const cleared = await clearPairingCache(threadCache, () => persistence.forget());
      setThreadCache(null);
      setSession(null);
      setError(
        !cleared
          ? "This device was revoked. Could not clear local storage. Clear Canopy’s app data before pairing again."
          : "This device was revoked. Pair it again in web Settings.",
      );
    },
  };
}

const Context = createContext<ReturnType<typeof useSessionState> | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useSessionState()}>{children}</Context.Provider>;
}

export function useSession() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing SessionProvider");

  return value;
}
