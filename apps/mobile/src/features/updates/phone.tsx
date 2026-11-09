import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import * as Updates from "expo-updates";
import { hasUnsentWork } from "./unsent-work";

function usePhoneUpdateState() {
  const status = Updates.useUpdates();
  const running = useRef(false);
  const [pending, setPending] = useState<"check" | "fetch" | "apply">();
  const [error, setError] = useState("");
  const [deferred, setDeferred] = useState(false);
  const [notice, setNotice] = useState("");

  async function run(action: "check" | "fetch" | "apply") {
    if (!Updates.isEnabled || running.current || status.isChecking || status.isDownloading || status.isRestarting)
      return;

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
      if (action === "check") await Updates.checkForUpdateAsync();
      else if (action === "fetch") await Updates.fetchUpdateAsync();
      else await Updates.reloadAsync();
    } catch {
      setError(
        action === "apply"
          ? "Could not restart Canopy. Retry, or close and reopen it to apply the update."
          : "Could not update this phone. Check your connection and retry.",
      );
    } finally {
      running.current = false;
      setPending(undefined);
    }
  }

  const busy = Boolean(
    pending || status.isChecking || status.isDownloading || status.isRestarting || status.isStartupProcedureRunning,
  );

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
