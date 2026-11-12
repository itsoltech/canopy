import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { groupThreadSyncDiagnostics } from "@canopy/domain/thread-sync-display";
import { useAppActive } from "../../ui/active";
import { Button } from "../../ui/components";
import { SettingsActions } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ThreadSyncDiagnostic } from "./ThreadSyncDiagnostic";

/** Mounted only inside an expanded computer; the parent's summary tick refreshes this bounded page. */
export function ThreadSyncComputerDetails({ computer }: { computer: ui.ThreadSyncComputer }) {
  const [cursors, setCursors] = useState([""]);
  const after = cursors.at(-1) ?? "";

  const resource = useSettingsResource(`GetThreadSyncDiagnostics:${computer.nodeId}:${after}`, (api) =>
    api.getThreadSyncDiagnostics({ computerNodeId: computer.nodeId, attentionOnly: true, after, pageSize: 25 }),
  );

  const active = useAppActive();
  const refresh = useEffectEvent(() => void resource.reload());
  useEffect(() => {
    if (active) refresh();
  }, [computer, active]);
  const data = resource.data;

  const entries = data
    ? (groupThreadSyncDiagnostics(data).computers.find((group) => group.computer.nodeId === computer.nodeId)?.entries ??
      [])
    : [];

  return (
    <ResourceState resource={resource} gap={8}>
      {entries.map((entry) => (
        <ThreadSyncDiagnostic key={entry.threadId} entry={entry} />
      ))}
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
