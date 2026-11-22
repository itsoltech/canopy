import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { readUsagePingEnabled, saveUsagePingEnabled, sendUsagePingIfDue } from "../storage/usage-ping";
import { useSession } from "./session";

interface UsagePingPreference {
  enabled: boolean | undefined;
  saving: boolean;
  error: string;
  change(enabled: boolean): Promise<void>;
}

const UsagePing = createContext<UsagePingPreference | undefined>(undefined);

export function UsagePingProvider({ children }: { children: ReactNode }) {
  const { ready, session, internetReachable } = useSession();
  const paired = ready && !!session;
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<boolean>(undefined);
  const writing = useRef(false);
  const loaded = enabled !== undefined;

  useEffect(() => {
    let mounted = true;
    void readUsagePingEnabled().then(
      (value) => {
        if (!mounted) return;
        current.current = value;
        setEnabled(value);
      },
      () => {
        if (mounted) setError("Could not load the usage ping setting. Restart Canopy to retry.");
      },
    );

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (__DEV__ || !paired || !loaded || !internetReachable) return;
    let watching = true;

    const allowed = () =>
      watching && AppState.currentState === "active" && current.current === true && !writing.current;

    const ping = () => void sendUsagePingIfDue(allowed);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") ping();
    });

    ping();

    return () => {
      watching = false;
      subscription.remove();
    };
  }, [paired, loaded, internetReachable]);

  async function change(value: boolean) {
    if (!loaded || writing.current) return;
    writing.current = true;
    setSaving(true);
    setError("");

    try {
      await saveUsagePingEnabled(value);
      current.current = value;
      setEnabled(value);
    } catch {
      setError("Could not save the usage ping setting. Try again.");
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  return <UsagePing.Provider value={{ enabled, saving, error, change }}>{children}</UsagePing.Provider>;
}

export function useUsagePing() {
  const value = useContext(UsagePing);

  if (!value) throw new Error("UsagePingProvider is missing");

  return value;
}
