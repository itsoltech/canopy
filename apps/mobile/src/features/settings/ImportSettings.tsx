import { useEffect, useEffectEvent, useRef, type ComponentRef } from "react";
import { useIsFocused, useLocalSearchParams, useRoute } from "expo-router";
import { EmptyState } from "../../ui/components";
import { ImportStart } from "../imports/ImportStart";
import { ImportRunGroup } from "./ImportRunGroup";
import { SettingsTopics } from "./SettingsTopics";
import { ResourceState, useSettingsResource } from "./resource";
import { useForegroundInterval } from "../../ui/interval";

/** Settings → Import: choose the computer's CLI sources and manage durable runs. */
export function ImportSettings() {
  const { worker = "", topic } = useLocalSearchParams<{ worker?: string; topic?: string }>();
  const route = useRoute();
  const topics = useRef<ComponentRef<typeof SettingsTopics>>(null);
  const resource = useSettingsResource("ListImportRuns", (api) => api.listImportRuns({}));
  const runs = resource.data?.runs ?? [];
  const active = runs.some((run) => run.status === "running" || run.status === "paused");
  // Only a running import reads every 3 s; a paused one changes when someone resumes or cancels it.
  const running = runs.some((run) => run.status === "running");
  const { reload } = resource;

  const focused = useIsFocused();
  const refresh = useEffectEvent(() => void reload());
  useEffect(() => {
    if (focused) refresh();
  }, [focused]);

  useForegroundInterval(() => void reload(), running ? 3000 : 15_000, active);

  return (
    <SettingsTopics
      ref={topics}
      scopeKey={topic || worker ? route.key : undefined}
      defaultTopic={worker ? "new-import" : topic}
      topics={[
        {
          id: "new-import",
          label: "New import",
          content: (
            <>
              <ImportStart
                key={worker}
                initialWorkerId={worker}
                onStarted={() => {
                  topics.current?.selectTopic("activity");
                  void reload();
                }}
              />
              {!runs.length && resource.data ? (
                <EmptyState
                  icon="arrow-down-tray"
                  title="No imports yet"
                  description="Scan a computer to choose threads and settings to bring into Canopy."
                />
              ) : null}
            </>
          ),
        },
        {
          id: "activity",
          label: "Import activity",
          hidden: !runs.length && !resource.error,
          content: (
            <ResourceState resource={resource}>
              {runs.map((run) => (
                <ImportRunGroup key={run.id} run={run} resource={resource} />
              ))}
            </ResourceState>
          ),
        },
      ]}
    />
  );
}
