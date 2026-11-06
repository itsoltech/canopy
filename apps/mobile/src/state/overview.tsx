import { createContext, useContext, useState, type ReactNode } from "react";
import { ui } from "@canopy/contracts";
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

  const forget = (nodeId: string) => {
    setWorkers((rows) => rows.filter((r) => r.nodeId !== nodeId));
    setProjects((rows) => rows.filter((r) => r.nodeId !== nodeId));
    setThreads((rows) => rows.filter((r) => r.nodeId !== nodeId));
  };

  const stream = useStream(
    client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null,
    (update: ui.OverviewUpdate) => {
      const change = update.change;

      if (change.case === "mobileRoutes") client?.update(change.value);

      if (change.case === "mobileSnapshot") {
        setProjects(change.value.overview?.projects ?? []);
        setWorkers(change.value.overview?.workers ?? []);
        setThreads(change.value.threads);
        setComputers(change.value.overview?.computers ?? []);
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

  return { threads: client ? threads : [], projects, workers, computers, loaded, stream };
}

const Context = createContext<ReturnType<typeof useOverviewState> | null>(null);

export function OverviewProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useOverviewState()}>{children}</Context.Provider>;
}

export function useOverview() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing OverviewProvider");

  return value;
}
