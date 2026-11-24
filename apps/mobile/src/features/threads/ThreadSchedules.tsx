import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useOpenSettingsSection } from "../settings/navigation";
import { ThreadPanelSection } from "./ThreadPanelSection";

export function ThreadSchedules({
  snapshot,
  schedules,
  unavailable,
  disabled,
  onClose,
}: {
  snapshot: ui.ThreadSnapshot;
  schedules: readonly ui.Schedule[];
  unavailable: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const openSettingsSection = useOpenSettingsSection();

  return (
    <ThreadPanelSection title="Scheduled tasks" count={schedules.length || undefined}>
      {schedules.map((schedule) => (
        <View key={schedule.id} style={[styles.row, { minHeight: 40 }]}>
          <Icon name="clock" />
          <Text numberOfLines={1} style={[type.chrome, { flex: 1, color: c.text }]}>
            {schedule.name || "Scheduled task"}
          </Text>
          <Text style={[type.meta, { color: c.muted }]}>{schedule.status}</Text>
        </View>
      ))}
      {unavailable && <Text style={[type.meta, { color: c.muted }]}>Connect to load scheduled tasks</Text>}
      <Button
        title="Manage thread schedules"
        variant="ghost"
        size="sm"
        icon="clock"
        style={{ minHeight: 40, justifyContent: "flex-start", paddingLeft: 0 }}
        disabled={disabled}
        onPress={() => {
          onClose();
          openSettingsSection("schedules", { threadId: snapshot.thread?.id ?? "" });
        }}
      />
    </ThreadPanelSection>
  );
}
