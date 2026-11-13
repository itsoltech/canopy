import { Text, View } from "react-native";
import { groupThreadSyncDiagnostics, threadSyncLastTime, threadSyncTotals } from "@canopy/domain/thread-sync-display";
import { useForegroundInterval } from "../../ui/interval";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ThreadSyncComputer } from "./ThreadSyncComputer";

/** Only a focused, foreground page polls scalar computer summaries. */
export function ThreadSyncDiagnostics() {
  const resource = useSettingsResource("GetThreadSyncDiagnostics:summary", (api) =>
    api.getThreadSyncDiagnostics({ summaryOnly: true }),
  );

  const c = useColors();
  useForegroundInterval(() => void resource.reload(), 5000);
  const grouped = resource.data ? groupThreadSyncDiagnostics(resource.data) : undefined;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Thread sync"
        description="Sync with linked computers."
        actions={
          <IconButton
            icon="arrow-path"
            label="Refresh sync status"
            disabled={resource.loading}
            onPress={() => void resource.reload()}
          />
        }
      >
        {!grouped ? (
          <Text style={[styles.chrome, { color: c.muted }]}>Loading sync status…</Text>
        ) : !grouped.computers.length ? (
          <Text style={[styles.chrome, { color: c.muted }]}>No threads synced from linked computers</Text>
        ) : grouped.allCaughtUp ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }} accessibilityLiveRegion="polite">
            <Icon name="check" />
            <View style={{ minWidth: 0, flex: 1, gap: 4 }}>
              <Text style={[styles.chrome, { color: c.text }]}>All threads are up to date</Text>
              <Text style={[styles.workMeta, { color: c.muted }]}>{threadSyncLastTime(grouped.lastSyncedAtMs)}</Text>
            </View>
          </View>
        ) : (
          <>
            {grouped.syncing || grouped.paused ? (
              <Text accessibilityLiveRegion="polite" style={[styles.chrome, { color: c.text }]}>
                {threadSyncTotals(grouped.syncing, grouped.paused, grouped.remaining)}
              </Text>
            ) : null}
            {grouped.computers.map(({ computer }) => (
              <ThreadSyncComputer key={computer.nodeId} computer={computer} />
            ))}
          </>
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
