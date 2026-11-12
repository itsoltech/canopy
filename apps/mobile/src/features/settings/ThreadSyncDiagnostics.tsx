import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { View } from "react-native";
import { formatCount } from "@canopy/domain/format";
import { useAppActive } from "../../ui/active";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsActions } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { ThreadSyncDiagnostic } from "./ThreadSyncDiagnostic";

/** Only a mounted, foreground settings page polls; rows and queries are bounded. */
export function ThreadSyncDiagnostics() {
  const [cursors, setCursors] = useState([""]);
  const after = cursors.at(-1) ?? "";

  const resource = useSettingsResource(`GetThreadSyncDiagnostics:${after}`, (api) =>
    api.getThreadSyncDiagnostics({ after, pageSize: 50 }),
  );

  const active = useAppActive();
  const { reload } = resource;
  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      const timer = setInterval(() => void reload(), 5000);

      return () => clearInterval(timer);
    }, [active, reload]),
  );
  const data = resource.data;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Thread sync"
        description="Progress on this gateway. Saved messages stay available while a computer is unreachable."
        actions={<Button title="Refresh" disabled={resource.loading} onPress={() => void reload()} />}
      >
        <SettingsValue
          title="Remaining"
          value={`${formatCount(data?.remaining ?? 0n)} to go`}
          description="Records still needed to catch up with linked computers."
        />
        <SettingsValue
          title="Threads"
          description="Catching up / paused"
          value={`${data?.syncingThreads ?? 0} / ${data?.failedThreads ?? 0}`}
        />
        {data?.entries.map((entry) => (
          <ThreadSyncDiagnostic key={entry.threadId} entry={entry} />
        ))}
        {data && !data.entries.length ? <SettingsValue title="No mirrored threads on this page" value="0" /> : null}
      </SettingsGroup>
      {cursors.length > 1 || data?.next ? (
        <View>
          <SettingsActions>
            <Button
              title="Previous"
              disabled={resource.loading || cursors.length < 2}
              onPress={() => setCursors((previous) => previous.slice(0, -1))}
            />
            <Button
              title="Next"
              disabled={resource.loading || !data?.next}
              onPress={() => {
                if (data?.next) setCursors((previous) => [...previous, data.next]);
              }}
            />
          </SettingsActions>
        </View>
      ) : null}
    </ResourceState>
  );
}
