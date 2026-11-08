import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ui } from "@canopy/contracts";
import {
  forgetComputerProjects,
  retainProjects,
  retainLinkedRows,
  workersWithAvailability,
} from "@canopy/domain/linked-snapshot";
import { useSession } from "./session";
import { useStream } from "./stream";

const upsert = <T extends { id: string }>(rows: T[], value: T) => [...rows.filter((r) => r.id !== value.id), value];

const upsertComputer = (rows: ui.LinkedComputer[], value: ui.LinkedComputer) => [
  ...rows.filter((r) => r.nodeId !== value.nodeId),
  value,
];

function useOverviewState() {
  const { client, session } = useSession();
  const [threads, setThreads] = useState<ui.Thread[]>([]);
  const [projects, setProjects] = useState<ui.Project[]>([]);
  const [workers, setWorkers] = useState<ui.Worker[]>([]);
  const [computers, setComputers] = useState<ui.LinkedComputer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [linkedReads, setLinkedReads] = useState<Record<string, number>>({});
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!client) return;
    const requested = ++generation.current;

    const [overview, list] = await Promise.all([
      client.api.getOverview({}),
      client.api.listThreads({ sidebarOnly: true }),
    ]);

    if (requested !== generation.current) return;
    setProjects((rows) => retainProjects(rows, overview.projects, overview.computers));
    setWorkers((rows) => retainLinkedRows(rows, overview.workers, overview.computers));
    setComputers(overview.computers);
    setThreads((rows) => retainLinkedRows(rows, list.threads, overview.computers));
    setLoaded(true);
  }, [client]);

  useEffect(() => {
    const requests = generation;
    void reload().catch(() => undefined);

    return () => {
      requests.current++;
    };
  }, [reload]);

  const forget = (nodeId: string) => {
    setWorkers((rows) => rows.filter((r) => r.nodeId !== nodeId));
    setProjects((rows) => forgetComputerProjects(rows, nodeId));
    setThreads((rows) => rows.filter((r) => r.nodeId !== nodeId));
  };

  const stream = useStream(
    client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null,
    (update: ui.OverviewUpdate) => {
      const change = update.change;

      if (change.case === "gatewayDeparture") {
        client?.departure.receive(change.value);

        return;
      }

      if (change.case === "mobileRoutes") {
        client?.update(change.value);

        return;
      }

      generation.current++;

      if (change.case === "linkedReadCompleted")
        setLinkedReads((revisions) => ({ ...revisions, [change.value]: (revisions[change.value] ?? 0) + 1 }));

      if (change.case === "linkedReadCompleted" && ["GetOverview", "ListThreads"].includes(change.value))
        void reload().catch(() => undefined);

      if (change.case === "mobileSnapshot") {
        if (client?.departure.snapshot())
          void client.api
            .getUpdates({})
            .then((snapshot) => client.departure.reconcile(snapshot))
            .catch(() => {});
        const next = change.value.overview;
        const peers = next?.computers ?? [];
        setProjects((rows) => retainProjects(rows, next?.projects ?? [], peers));
        setWorkers((rows) => retainLinkedRows(rows, next?.workers ?? [], peers));
        setThreads((rows) => retainLinkedRows(rows, change.value.threads, peers));
        setComputers(peers);
        setLoaded(true);
      }

      if (change.case === "computer") setComputers((rows) => upsertComputer(rows, change.value));

      // Unlinked: its workers, projects and threads leave the lists.
      if (change.case === "computerRemoved") {
        setComputers((rows) => rows.filter((c) => c.nodeId !== change.value));
        forget(change.value);
      }

      // A linked computer reconnected: its rows replace the ones listed before.
      if (change.case === "computerSnapshot") {
        const { nodeId, overview, threads: listed } = change.value;

        forget(nodeId);
        setWorkers((rows) => [...rows, ...(overview?.workers ?? [])]);
        setProjects((rows) => [...rows, ...(overview?.projects ?? [])]);
        setThreads((rows) => [...rows, ...listed]);
      }

      if (change.case === "thread") setThreads((rows) => upsert(rows, change.value));

      if (change.case === "project") setProjects((rows) => upsert(rows, change.value));

      if (change.case === "worker") setWorkers((rows) => upsert(rows, change.value));

      if (change.case === "workerRemoved") setWorkers((rows) => rows.filter((r) => r.id !== change.value));
    },
    `overview:${session?.deviceId}`,
  );

  return {
    threads: client ? threads : [],
    projects,
    workers: workersWithAvailability(workers, computers),
    computers,
    loaded,
    linkedReads,
    stream,
    reload,
  };
}

const Context = createContext<ReturnType<typeof useOverviewState> | null>(null);

export function OverviewProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();

  return <OverviewSession key={session?.deviceId}>{children}</OverviewSession>;
}

function OverviewSession({ children }: { children: ReactNode }) {
  return <Context.Provider value={useOverviewState()}>{children}</Context.Provider>;
}

export function useOverview() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing OverviewProvider");

  return value;
}
