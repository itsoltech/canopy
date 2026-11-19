import { Pressable, Text } from "react-native";
import Animated from "react-native-reanimated";
import { Rule } from "../../ui/Badge";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { Chevron } from "../../ui/MotionViews";
import { font, styles, useColors } from "../../ui/theme";

export function ChatEventGroupHeader({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const c = useColors();
  const { header, toggle } = useAnchoredToggle();

  return (
    <Animated.View ref={header} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(onToggle)}
        style={({ pressed }) => [styles.row, { minHeight: 44, gap: 8 }, pressed && { backgroundColor: c.pressed }]}
      >
        <Chevron open={open} size={16} color={c.faint} />
        <Text
          style={[
            styles.meta,
            { flexShrink: 1, color: c.muted, fontFamily: font.medium, fontVariant: ["tabular-nums"] },
          ]}
        >
          {`${open ? "Hide" : "Show"} ${count.toLocaleString("en")} events`}
        </Text>
        <Rule />
      </Pressable>
    </Animated.View>
  );
}
