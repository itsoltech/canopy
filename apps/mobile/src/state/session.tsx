import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { useNetworkState } from "expo-network";
import { mobileClient } from "../api/client";
import { deleteSession, loadSession, saveSession, type DeviceSession } from "../storage/session";

function useSessionState() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(AppState.currentState !== "background");
  const network = useNetworkState();
  useEffect(() => {
    void loadSession()
      .then(setSession)
      .catch(() => setError("Could not read secure storage. Pair this phone again."))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));

    return () => sub.remove();
  }, []);

  const client = useMemo(
    () =>
      session
        ? mobileClient({
            gatewayUrl: session.gatewayUrl,
            token: session.token,
            fetch: expoFetch as typeof globalThis.fetch,
            development: __DEV__,
          })
        : null,
    [session],
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
      await saveSession(value);
      setSession(value);
      setError("");
    },
    async forget() {
      await deleteSession();
      setSession(null);
      setError("");
    },
    async expired() {
      try {
        await deleteSession();
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
