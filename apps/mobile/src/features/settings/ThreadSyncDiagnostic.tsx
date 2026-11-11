import { View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { threadSyncProgress, threadSyncFailure } from "@canopy/domain/thread-sync-display";
import { formatBytes } from "@canopy/domain/format";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsValue } from "./SettingsValue";
import { Button } from "../../ui/components";

export function ThreadSyncDiagnostic({ entry }: { entry: ui.ThreadSyncDiagnostic }) {
  const status = entry.reason ? threadSyncFailure(entry.reason) : threadSyncProgress(entry);

  return (
    <SettingsDisclosure title={`${entry.computerName} · ${status}`}>
      <SettingsValue title="Applied / available" value={`${entry.appliedSeq} / ${entry.headSeq}`} />
      <SettingsValue title="Remaining" value={entry.remaining.toString()} />
      {entry.reason ? (
        <>
          <SettingsValue title="Failure code" value={`${entry.reason} · ${entry.code}`} />
          <SettingsValue title="Recovery" value={entry.retryable ? "Automatic retry" : "Waiting for a change"} />
          <SettingsValue
            title="Failed frame"
            value={entry.frameBytes ? formatBytes(entry.frameBytes) : "Not available"}
          />
        </>
      ) : null}
      <View style={{ alignItems: "flex-end" }}>
        <Button
          title="Open thread"
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: entry.threadId } })}
        />
      </View>
    </SettingsDisclosure>
  );
}
