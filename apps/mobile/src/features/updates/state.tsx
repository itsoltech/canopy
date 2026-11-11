import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { updatesRunning, type UpdateRequest } from "./model";
import { useOverview } from "../../state/overview";
import { confirmAppUpdate } from "./confirmation";
import { useUpdateNotices } from "./use-update-notices";

function useUpdateGeneration() {
  const { client } = useSession();
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;

    return () => {
      generation.current++;
    };
  }, [client]);

  return generation;
}

function useUpdatesState() {
  const { client, active, online } = useSession();
  const overview = useOverview();
  const [snapshot, setSnapshot] = useState<ui.UpdatesSnapshot>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [loadError, setLoadError] = useState("");
  const running = useRef(false);
  const generation = useUpdateGeneration();

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
  const { pushed, nudge } = useUpdateNotices(active, online);

  useEffect(() => {
    if (!client || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delay = busy ? 2500 : pushed ? undefined : 60_000;

    const tick = async () => {
      await reload(controller.signal);

      if (!controller.signal.aborted && delay !== undefined) timer = setTimeout(() => void tick(), delay);
    };

    // A change notice is merged with others arriving in the same moment.
    timer = setTimeout(() => void tick(), nudge ? 150 : 0);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, active, online, reload, open, busy, pushed, nudge]);

  async function manage(request: UpdateRequest) {
    if (!client || running.current) return;
    const current = generation.current;

    if (
      confirmAppUpdate(
        request,
        snapshot,
        overview.threads,
        (confirmed) => {
          if (current === generation.current) void manage(confirmed);
        },
        (message) => {
          setError(message);
          setDetails("");
        },
      )
    )
      return;
    running.current = true;
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
