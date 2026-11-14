import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { openSettingsSection } from "../settings/navigation";
import type { ui } from "@canopy/contracts";
import { ConnectionStatus, type StreamState } from "./ConnectionStatus";
import { IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { UpdateCenterButton } from "../updates/UpdateCenter";
import { DraftActions } from "../drafts/DraftActions";

export function SidebarFooter({ workers, stream }: { workers: ui.Worker[]; stream: StreamState }) {
  const c = useColors();

  return (
    <View style={[styles.row, { borderTopWidth: 1, borderTopColor: c.line, padding: 8 }]}>
      <IconButton icon="cog-6-tooth" label="Settings" onPress={() => router.push("/settings")} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Workers online"
        onPress={() => openSettingsSection("workers")}
        style={[styles.row, { minHeight: 44 }]}
      >
        <Icon name="server" size={14} />
        <Text style={[styles.meta, { color: c.muted }]}>
          {workers.filter((w) => w.online).length}/{workers.length}
        </Text>
      </Pressable>
      <UpdateCenterButton />
      <DraftActions overview />
      <View style={[styles.row, { flex: 1, justifyContent: "flex-end" }]}>
        <ConnectionStatus stream={stream} />
      </View>
    </View>
  );
}
