import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ui } from "@canopy/contracts";
import { subagentLook, subagentState } from "@canopy/domain/subagents";
import { formatAge } from "@canopy/domain/format";
import { firstLine } from "@canopy/domain/first-line";
import { StatusDot } from "../../ui/Badge";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { providerName } from "../models/catalog";

export function SubagentLineageRow({
  thread,
  now,
  onOpen,
  style,
}: {
  thread: ui.Thread;
  now: number;
  onOpen: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const state = subagentState(thread);
  const look = subagentLook(state);
  const tone = useTone(look.tone);
  const model = thread.model || `${providerName(thread.provider)} default`;
  const snippet = firstLine(thread.lastMessage).text || (state === "working" ? "Working on it…" : "No message yet");
  const age = formatAge(thread.lastActivityAt ?? thread.createdAt, now);

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => onOpen(thread.id)}
      style={({ pressed }) => [
        styles.row,
        { minHeight: 44, padding: 8, borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined },
        style,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.row}>
          <StatusDot tone={look.tone} active={look.active} />
          <Text numberOfLines={1} style={[styles.overlay, { flex: 1, minWidth: 0, color: c.text }]}>
            {thread.title || "Subagent"}
          </Text>
          <Icon name="chevron-right" />
        </View>
        <View style={styles.row}>
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: tone.text, flexShrink: 0 }]}>
            {look.label}
            {!look.active && age ? ` · ${age}` : ""}
          </Text>
          <ProviderIcon provider={thread.provider} />
          <Text numberOfLines={1} style={[styles.overlayMeta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {model}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
          {snippet}
        </Text>
      </View>
    </Pressable>
  );
}
