import { Pressable, ScrollView, Text } from "react-native";
import type { ComposerPendingItem } from "@canopy/domain/composer-pending";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function ComposerPending({ items, onExpand }: { items: readonly ComposerPendingItem[]; onExpand: () => void }) {
  const c = useColors();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ maxWidth: "65%", flexGrow: 0, flexShrink: 1 }}
      contentContainerStyle={{ alignItems: "center", gap: 4 }}
    >
      {items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={onExpand}
          hitSlop={{ top: 12, bottom: 12 }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            height: 24,
            paddingLeft: 4,
            paddingRight: 6,
            borderRadius: 6,
            backgroundColor: pressed ? c.inset : c.softAccent,
          })}
        >
          <Icon name={item.icon} size={14} color={c.accent} />
          <Text style={[styles.meta, { color: c.accent, fontVariant: ["tabular-nums"] }]}>
            {item.count.toLocaleString()}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
