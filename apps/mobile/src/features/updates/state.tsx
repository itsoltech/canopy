import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { updatesRunning, type UpdateRequest } from "./model";

function useUpdatesState() {
  const { client, active, online } = useSession();
  const [snapshot, setSnapshot] = useState<ui.UpdatesSnapshot>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [loadError, setLoadError] = useState("");
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;

    return () => {
      generation.current++;
    };
  }, [client]);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return;
      const current = generation.current;

      try {
        const value = await client.api.getUpdates({}, { ...(signal && { signal }), timeoutMs: 10_000 });

        if (current === generation.current && !signal?.aborted) {
          setSnapshot(value);
          setLoadError("");
          client.departure.reconcile(value);
        }
      } catch {
        if (current === generation.current && !signal?.aborted)
          setLoadError("Could not load updates. Check the connection and retry.");
      }
    },
    [client],
  );

  const busy = !!snapshot && updatesRunning(snapshot);
  useEffect(() => {
    if (!client || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      await reload(controller.signal);

      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), open || busy ? 2500 : 15_000);
    };

    void tick();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, active, online, reload, open, busy]);

  async function manage(request: UpdateRequest) {
    if (!client || running.current) return;
    running.current = true;
    const current = generation.current;
    setPending(request.action || "update");
    setError("");
    setDetails("");

    try {
      const value =
        request.action === "check" && !snapshot?.admin && !snapshot?.gatewayBundled
          ? undefined
          : await client.api.manageUpdates(request, { timeoutMs: 150_000 });

      if (request.action === "check") await client.api.checkCliUpdates({}, { timeoutMs: 30_000 });

      if (value && current === generation.current) setSnapshot(value);
      await reload();
    } catch (cause) {
      if (current === generation.current) {
        setError("Canopy could not finish this update action. Check the connection and retry.");
        setDetails(ConnectError.from(cause).rawMessage);
      }
    } finally {
      if (current === generation.current) {
        running.current = false;
        setPending("");
      }
    }
  }

  return {
    snapshot,
    open,
    setOpen,
    pending,
    error: error || (!snapshot ? loadError : ""),
    details,
    reload,
    manage,
    dismissError: () => {
      setError("");
      setDetails("");
    },
  };
}

const Context = createContext<ReturnType<typeof useUpdatesState> | null>(null);

export function UpdatesProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useUpdatesState()}>{children}</Context.Provider>;
}

export function useUpdates() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing UpdatesProvider");

  return value;
}
