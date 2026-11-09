import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverviewEvents } from "../../state/overview-bus";
import { workerUpdateSignature } from "@canopy/domain/update-checks";
import { updatesRunning, type UpdateRequest } from "./model";

/** Overview updates after which the update center may show something new. */
const UPDATE_EVENTS = new Set([
  "updatesChanged",
  "desktopUpdate",
  "gatewayDeparture",
  "computer",
  "workerRemoved",
  "feeds",
]);

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
  const [pushed, setPushed] = useState(false);
  const [nudge, setNudge] = useState(0);
  const workers = useRef(new Map<string, string>());

  // The gateway announces update center changes; only an update in progress reads every 2.5 s, and a gateway
  // that does not push them (older) gets one read a minute in the foreground.
  useOverviewEvents((update) => {
    const change = update.change;

    if (change.case === "feeds") setPushed(change.value.pushed.includes("updates"));

    if (change.case === "worker") {
      const signature = workerUpdateSignature(change.value);
      const previous = workers.current.get(change.value.id);
      workers.current.set(change.value.id, signature);

      if (previous === undefined || previous === signature) return;
    } else if (
      !UPDATE_EVENTS.has(change.case ?? "") &&
      !(change.case === "linkedReadCompleted" && change.value === "GetComputerUpdates")
    )
      return;

    setNudge((n) => n + 1);
  });

  useEffect(() => {
    if (!active || !online) setPushed(false);
  }, [active, online]);

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
