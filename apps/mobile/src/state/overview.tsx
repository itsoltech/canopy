import { createContext, useContext, useState, type ReactNode } from "react";
import { ui } from "@canopy/contracts";
import { useSession } from "./session";
import { useStream } from "./stream";

const upsert = <T extends { id: string }>(rows: T[], value: T) => [...rows.filter((r) => r.id !== value.id), value];

function useOverviewState() {
  const { client, session } = useSession();
  const [threads, setThreads] = useState<ui.Thread[]>([]);
  const [projects, setProjects] = useState<ui.Project[]>([]);
  const [workers, setWorkers] = useState<ui.Worker[]>([]);
  const [loaded, setLoaded] = useState(false);

  const stream = useStream(
    client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null,
    (update: ui.OverviewUpdate) => {
      const change = update.change;

      if (change.case === "mobileSnapshot") {
        setProjects(change.value.overview?.projects ?? []);
        setWorkers(change.value.overview?.workers ?? []);
        setThreads(change.value.threads);
        setLoaded(true);
      }

      if (change.case === "thread") setThreads((rows) => upsert(rows, change.value));

      if (change.case === "project") setProjects((rows) => upsert(rows, change.value));

      if (change.case === "worker") setWorkers((rows) => upsert(rows, change.value));

      if (change.case === "workerRemoved") setWorkers((rows) => rows.filter((r) => r.id !== change.value));
    },
    `overview:${session?.deviceId}`,
  );

  return { threads: client ? threads : [], projects, workers, loaded, stream };
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
