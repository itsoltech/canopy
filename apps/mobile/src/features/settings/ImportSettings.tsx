import { useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { EmptyState } from "../../ui/components";
import { ImportStart } from "../imports/ImportStart";
import { ImportRunGroup } from "./ImportRunGroup";
import { ResourceState, useSettingsResource } from "./resource";

/** Settings → Import: choose the computer's CLI sources and manage durable runs. */
export function ImportSettings() {
  const { worker = "" } = useLocalSearchParams<{ worker?: string }>();
  const resource = useSettingsResource("ListImportRuns", (api) => api.listImportRuns({}));
  const runs = resource.data?.runs ?? [];
  const active = runs.some((run) => run.status === "running" || run.status === "paused");
  const { reload } = resource;

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => {
      if (AppState.currentState === "active") void reload();
    }, 3000);

    return () => clearInterval(timer);
  }, [active, reload]);

  return (
    <ResourceState resource={resource}>
      <ImportStart key={worker} initialWorkerId={worker} onStarted={() => void reload()} />
      {!runs.length && resource.data ? (
        <EmptyState
          icon="arrow-down-tray"
          title="No imports yet"
          description="Scan a computer to choose threads and settings to bring into Canopy."
        />
      ) : null}
      {runs.map((run) => (
        <ImportRunGroup key={run.id} run={run} resource={resource} />
      ))}
    </ResourceState>
  );
}
