import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { updatesRunning, type UpdateRequest } from "./model";
import { useOverview } from "../../state/overview";
import { confirmAppUpdate } from "./confirmation";
import { useUpdateNotices } from "./use-update-notices";
import { plannedUpdateRun } from "@canopy/domain/release/update-plan";
import { furthestStatus, runStatuses, updateTargetKey, type UpdateStatus } from "@canopy/domain/release/update-status";

/** What the user just asked for, shown at once and replaced by the gateway's answer (or reverted by its error). */
interface Optimistic {
  run: ui.UpdateRun | undefined;
  rows: ReadonlyMap<string, UpdateStatus>;
}

function expected(request: UpdateRequest, snapshot: ui.UpdatesSnapshot | undefined, target: string) {
  if (request.action === "update_all" && snapshot) return { run: plannedUpdateRun(snapshot, ""), rows: new Map() };
  const steps = snapshot?.run?.steps ?? [];
  let retried: ui.UpdateStep[] = [];

  if (request.action === "retry_failed") retried = steps.filter((step) => ["failed", "blocked"].includes(step.state));

  if (request.action === "retry_step") retried = steps.filter((_, index) => index === (request.updateStepIndex ?? 0));

  const rows = new Map<string, UpdateStatus>([
    ...retried.map((step) => [updateTargetKey(step), "starting"] as const),
    ...(target ? [[target, "starting"] as const] : []),
  ]);

  return rows.size ? { run: undefined, rows } : undefined;
}

/** Web: UpdatesState.run / rowStatus / failedStep. Each row's state from the run and the user's last action. */
function useRunRows(snapshot: ui.UpdatesSnapshot | undefined, optimistic: Optimistic | undefined, pending: string) {
  // The run rows follow: the gateway's while it runs, otherwise the one just requested.
  const run = snapshot?.run?.state === "running" ? snapshot.run : (optimistic?.run ?? snapshot?.run);
  const statuses = useMemo(() => runStatuses(run), [run]);

  return {
    run,
    /** An action is pending or Update all runs: row actions wait (this computer restarts last). */
    active: !!pending || run?.state === "running",
    /** A row's badge: the further of its own state, its run step and what the user just started. */
    rowStatus: (key: string, own: UpdateStatus | string) =>
      furthestStatus(furthestStatus(own, statuses.get(key)), optimistic?.rows.get(key)),
    /** A row's failed step in the stopped run, for its Retry; -1 without one. */
    failedStep: (key: string) =>
      snapshot?.run && snapshot.run.state !== "running"
        ? snapshot.run.steps.findIndex(
            (step) => ["failed", "blocked"].includes(step.state) && updateTargetKey(step) === key,
          )
        : -1,
  };
}

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
  const [optimistic, setOptimistic] = useState<Optimistic>();
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [loadError, setLoadError] = useState("");
  const running = useRef(false);
  const snapshotRevision = useRef(0);
  const generation = useUpdateGeneration();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return;
      const current = generation.current;
      const revision = snapshotRevision.current;

      try {
        const value = await client.api.getUpdates({}, { ...(signal && { signal }), timeoutMs: 10_000 });

        if (current === generation.current && revision === snapshotRevision.current && !signal?.aborted) {
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

  const rows = useRunRows(snapshot, optimistic, pending);
  // While an action is pending, reads keep going so its progress shows as soon as it starts.
  const busy = !!pending || (!!snapshot && updatesRunning(snapshot));
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

  /** `target`: the row the action belongs to (`updateTargetKey`), shown as Starting until the answer arrives. */
  async function manage(request: UpdateRequest, target = "") {
    if (!client || running.current) return;
    const current = generation.current;

    if (
      confirmAppUpdate(
        request,
        snapshot,
        overview.threads,
        (confirmed) => {
          if (current === generation.current) void manage(confirmed, target);
        },
        (message) => {
          setError(message);
          setDetails("");
        },
      )
    )
      return;
    running.current = true;
    snapshotRevision.current++;
    setPending(request.action || "update");
    setOptimistic(expected(request, snapshot, target));
    setError("");
    setDetails("");

    try {
      const value =
        request.action === "check" && !snapshot?.admin && !snapshot?.gatewayBundled
          ? undefined
          : await client.api.manageUpdates(request, { timeoutMs: 150_000 });

      if (request.action === "check") await client.api.checkCliUpdates({}, { timeoutMs: 30_000 });

      if (value && current === generation.current) {
        snapshotRevision.current++;
        setSnapshot(value);
      }

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
        setOptimistic(undefined);
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
    optimistic,
    ...rows,
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
