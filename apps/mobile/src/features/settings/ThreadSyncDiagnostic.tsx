import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { threadSyncFailure, threadSyncRecords } from "@canopy/domain/thread-sync-display";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function ThreadSyncDiagnostic({ entry }: { entry: ui.ThreadSyncDiagnostic }) {
  const c = useColors();

  return (
    <View style={{ gap: 4, minWidth: 0, paddingVertical: 8 }}>
      <Text style={[styles.chrome, { color: c.text }]}>{entry.threadTitle || "Untitled thread"}</Text>
      <Text style={[styles.workMeta, { color: c.muted }]}>
        {entry.reason ? `Sync paused · ${threadSyncFailure(entry.reason)}` : "Catching up"}
        {entry.remaining ? ` · ${threadSyncRecords(entry.remaining)}` : ""}
      </Text>
      {entry.reason ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          {entry.retryable ? "Retrying automatically." : "Check the linked computer."}
        </Text>
      ) : null}
      <View style={{ alignItems: "flex-start" }}>
        <Button
          title="Open thread"
          variant="ghost"
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: entry.threadId } })}
        />
      </View>
    </View>
  );
}
