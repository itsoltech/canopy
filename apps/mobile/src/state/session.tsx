import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useNetworkState } from "expo-network";
import { routedMobileClient } from "../api/routes";
import { pinnedTransport } from "../api/pinned";
import { SessionPersistence, type DeviceSession } from "../storage/session";

function useSessionState() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [persistence] = useState(() => new SessionPersistence());
  const [active, setActive] = useState(AppState.currentState !== "background");
  const network = useNetworkState();
  useEffect(() => {
    void persistence
      .load()
      .then(setSession)
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
    ready,
    error,
    active,
    // A private tailnet gateway may be reachable even when public internet probes fail.
    online: network.isConnected !== false,
    async pair(value: DeviceSession) {
      await persistence.save(value);
      setSession(value);
      setError("");
    },
    async forget() {
      await persistence.forget();
      setSession(null);
      setError("");
    },
    async expired() {
      try {
        await persistence.forget();
      } catch {
        /* The revoked credential cannot authorize another RPC. */
      }

      setSession(null);
      setError("This device was revoked. Pair it again in web Settings.");
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
