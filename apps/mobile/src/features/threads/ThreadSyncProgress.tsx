import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { threadSyncProgress, threadSyncCount } from "@canopy/domain/thread-sync-display";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function ThreadSyncProgress({ status }: { status?: ui.ThreadSyncStatus }) {
  const c = useColors();

  return (
    <View style={{ width: 64, alignItems: "flex-end" }}>
      {status && (
        <View
          accessible
          accessibilityLabel={threadSyncProgress(status)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Icon name={status.reason ? "exclamation-triangle" : status.caughtUp ? "check" : "arrow-path"} />
          <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
            {threadSyncCount(status.remaining)}
          </Text>
        </View>
      )}
    </View>
  );
}
