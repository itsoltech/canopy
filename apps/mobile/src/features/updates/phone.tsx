import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import * as Updates from "expo-updates";
import { whileForeground } from "../../state/foreground-work";
import { hasUnsentWork } from "./unsent-work";

const CHECK_INTERVAL_MS = 15 * 60_000;

function usePhoneUpdateState() {
  const status = Updates.useUpdates();
  const running = useRef(false);
  const [pending, setPending] = useState<"check" | "fetch" | "apply">();
  const [lastAttempt, setLastAttempt] = useState(0);
  const [error, setError] = useState("");
  const [deferred, setDeferred] = useState(false);
  const [notice, setNotice] = useState("");

  const nativeBusy =
    status.isChecking || status.isDownloading || status.isRestarting || status.isStartupProcedureRunning;

  const busy = Boolean(pending || nativeBusy);

  async function run(action: "check" | "fetch" | "apply", automatic = false) {
    if (!Updates.isEnabled || running.current || nativeBusy) return;

    if (action === "apply" && !status.isUpdatePending) return;
    setError("");

    if (action === "apply" && hasUnsentWork()) {
      setDeferred(true);
      setNotice("Update saved for the next launch. Send or discard your drafts and files before applying it here.");

      return;
    }

    running.current = true;
    setPending(action);
    setNotice("");

    try {
      if (action === "check") {
        const result = await Updates.checkForUpdateAsync();

        if (automatic && (result.isAvailable || result.isRollBackToEmbedded)) {
          setPending("fetch");
          await Updates.fetchUpdateAsync();
        }
      } else if (action === "fetch") await Updates.fetchUpdateAsync();
      else await Updates.reloadAsync();
    } catch {
      setError(
        action === "apply"
          ? "Could not restart Canopy. Retry, or close and reopen it to apply the update."
          : "Could not update this phone. Check your connection and retry.",
      );
    } finally {
      if (action !== "apply") setLastAttempt(Date.now());
      running.current = false;
      setPending(undefined);
    }
  }

  const checkWhenActive = useEffectEvent(() => {
    if (AppState.currentState === "active" && !status.isUpdatePending) void run("check", true);
  });

  const lastActivity = Math.max(lastAttempt, status.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0);

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__ || busy || status.isUpdatePending) return;

    return whileForeground(AppState, () => {
      const delay = Math.max(0, Math.min(CHECK_INTERVAL_MS, lastActivity + CHECK_INTERVAL_MS - Date.now()));
      const timer = setTimeout(checkWhenActive, delay);

      return () => clearTimeout(timer);
    });
  }, [busy, status.isUpdatePending, lastActivity]);

  return {
    status,
    pending,
    busy,
    error,
    notice,
    deferred,
    check: () => run("check"),
    fetch: () => run("fetch"),
    apply: () => run("apply"),
    defer() {
      setDeferred(true);
      setNotice("Update saved for the next launch. Keep working and reopen Canopy when you’re ready.");
    },
  };
}

const PhoneUpdates = createContext<ReturnType<typeof usePhoneUpdateState> | null>(null);

export function PhoneUpdatesProvider({ children }: { children: ReactNode }) {
  const value = usePhoneUpdateState();

  return <PhoneUpdates.Provider value={value}>{children}</PhoneUpdates.Provider>;
}

export function usePhoneUpdates() {
  const value = useContext(PhoneUpdates);

  if (!value) throw new Error("PhoneUpdatesProvider required");

  return value;
}
