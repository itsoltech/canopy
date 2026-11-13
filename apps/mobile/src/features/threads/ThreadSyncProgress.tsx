import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { threadSyncCount, threadSyncLabel, threadSyncVisible } from "@canopy/domain/thread-sync-display";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function ThreadSyncProgress({ status, compact = false }: { status?: ui.ThreadSyncStatus; compact?: boolean }) {
  const c = useColors();

  return (
    <View style={{ width: compact ? 16 : 64, alignItems: "flex-end" }}>
      {status && threadSyncVisible(status) && (
        <View
          accessible
          accessibilityLabel={threadSyncLabel(status)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Icon name={status.reason ? "exclamation-triangle" : "arrow-path"} />
          {!status.reason && !compact && (
            <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {threadSyncCount(status.remaining)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
