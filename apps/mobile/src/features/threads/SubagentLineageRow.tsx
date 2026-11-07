import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { subagentState, type SubagentState } from "@canopy/domain/subagents";
import { formatAge } from "@canopy/domain/format";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

const labels: Record<SubagentState, string> = {
  working: "Working",
  waiting: "Needs input",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

export function SubagentLineageRow({
  thread,
  now,
  onOpen,
}: {
  thread: ui.Thread;
  now: number;
  onOpen: (id: string) => void;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => onOpen(thread.id)}
      style={({ pressed }) => [
        styles.row,
        { minHeight: 52, padding: 8, borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined },
      ]}
    >
      <ProviderIcon provider={thread.provider} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[styles.body, { color: c.text }]}>
          {thread.title || "Subagent"}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
          {labels[subagentState(thread)]} · {formatAge(thread.lastActivityAt ?? thread.createdAt, now)}
        </Text>
      </View>
      <Icon name="chevron-right" />
    </Pressable>
  );
}
