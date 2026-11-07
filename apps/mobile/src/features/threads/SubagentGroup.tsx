import type { ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Chevron, Expand } from "../../ui/MotionViews";
import { useReducedMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";

/** The finished/previous disclosure shared by the composer overlay and thread details. */
export function SubagentGroup({
  label,
  open,
  onToggle,
  children,
  style,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const reduced = useReducedMotion();

  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.row,
          { minHeight: 44, paddingHorizontal: 8, borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined },
        ]}
      >
        <Text style={[styles.overlayMeta, { flex: 1, color: c.muted, fontVariant: ["tabular-nums"] }]}>{label}</Text>
        <Chevron open={open} />
      </Pressable>
      {reduced ? open ? children : null : <Expand open={open}>{children}</Expand>}
    </View>
  );
}
