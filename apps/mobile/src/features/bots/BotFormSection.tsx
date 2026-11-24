import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Chevron, Expand } from "../../ui/MotionViews";
import { useMinimumTouchTarget } from "../../ui/density";
import { useReducedMotion } from "../../ui/motion";
import { styles, useColors, useTypography, weightedFont } from "../../ui/theme";

export function BotFormSection({
  title,
  disabled,
  children,
}: {
  title: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const c = useColors();
  const type = useTypography();
  const target = useMinimumTouchTarget();
  const reduced = useReducedMotion();

  const panel = (
    <View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={{ paddingTop: 8, paddingBottom: 12 }}
    >
      {children}
    </View>
  );

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.row,
          { minHeight: target, paddingVertical: 6, backgroundColor: pressed ? c.pressed : "transparent" },
        ]}
      >
        <Text style={[type.body, weightedFont(type.body.fontFamily, "medium"), { flex: 1, color: c.text }]}>
          {title}
        </Text>
        <Chevron open={open} color={c.icon} />
      </Pressable>
      {reduced ? open && panel : <Expand open={open}>{panel}</Expand>}
    </View>
  );
}
