import { useCallback, useEffect } from "react";
import { AppState, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { EmptyState } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ImportRunGroup } from "./ImportRunGroup";
import { ResourceState, useSettingsResource } from "./resource";

/** Settings → Import: monitor and manage runs; source selection stays on web/desktop. */
export function ImportSettings() {
  const c = useColors();
  const resource = useSettingsResource("imports", (api) => api.listImportRuns({}));
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
      {runs.length > 0 ? (
        <View style={{ paddingHorizontal: 4 }}>
          <Text style={[styles.workMeta, { color: c.muted }]}>Choose what to import in the web or desktop app.</Text>
        </View>
      ) : resource.data ? (
        <EmptyState
          icon="arrow-down-tray"
          title="No imports yet"
          description="Bring threads and settings from Claude Code, Codex and Grok into Canopy in the web or desktop app."
        />
      ) : null}
      {runs.map((run) => (
        <ImportRunGroup key={run.id} run={run} resource={resource} />
      ))}
    </ResourceState>
  );
}
