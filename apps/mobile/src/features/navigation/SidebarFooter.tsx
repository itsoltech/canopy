import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { openSettingsSection } from "../settings/navigation";
import type { ui } from "@canopy/contracts";
import { ConnectionStatus, type StreamState } from "./ConnectionStatus";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { UpdateCenterButton } from "../updates/UpdateCenter";
import { SidebarUsage } from "./SidebarUsage";

export function SidebarFooter({ workers, stream }: { workers: ui.Worker[]; stream: StreamState }) {
  const c = useColors();
  const [compact, setCompact] = useState(true);
  const [connectionCompact, setConnectionCompact] = useState(true);
  const online = workers.filter((worker) => worker.online).length;

  return (
    <View
      onLayout={(event) => setCompact(event.nativeEvent.layout.width < 330)}
      style={[
        styles.row,
        {
          borderTopWidth: 1,
          borderTopColor: c.line,
          padding: 8,
          paddingHorizontal: compact ? 4 : 8,
          gap: compact ? 0 : 4,
        },
      ]}
    >
      <IconButton icon="cog-6-tooth" label="Settings" onPress={() => router.push("/settings")} />
      <IconButton icon="table-cells" label="Open usage" onPress={() => router.navigate("/usage")} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Workers online"
        accessibilityValue={{ text: `${online} of ${workers.length}` }}
        onPress={() => openSettingsSection("workers")}
        style={[styles.row, { minHeight: 44, minWidth: 40, justifyContent: "center", gap: 4 }]}
      >
        <Icon name="server" size={14} />
        {!compact && (
          <Text style={[styles.meta, { color: c.muted }]}>
            {online}/{workers.length}
          </Text>
        )}
      </Pressable>
      <UpdateCenterButton />
      <SidebarUsage workers={workers} />
      <View
        onLayout={(event) => setConnectionCompact(event.nativeEvent.layout.width < 128)}
        style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}
      >
        <ConnectionStatus stream={stream} compact={connectionCompact} />
      </View>
    </View>
  );
}
