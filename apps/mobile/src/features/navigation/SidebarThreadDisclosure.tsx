import { palette } from "@canopy/ui";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { interpolateColor } from "react-native-reanimated";
import { Chevron } from "../../ui/MotionViews";
import { useColors, weightedFont } from "../../ui/theme";
import { sidebarRowPadding, useSidebarTypography } from "./sidebar-scale";

export function SidebarThreadDisclosure({
  label,
  working = false,
  expanded,
  onToggle,
}: {
  label: string;
  working?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = useColors();
  const type = useSidebarTypography();
  // Match the themed sky and muted mix in the web disclosure, including the palette's surface tint.
  const sky = interpolateColor(0.94, [0, 1], [c.dark ? c.sidebar : c.inset, palette.sky[c.dark ? 300 : 800]], "LAB");
  const color = working ? interpolateColor(0.6, [0, 1], [c.muted, sky], "LAB") : c.soft;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={({ pressed }) => [styles.heading, pressed && { backgroundColor: c.pressed }]}
    >
      <Chevron open={expanded} size={16} color={working ? color : c.icon} />
      <Text
        numberOfLines={1}
        style={[
          type.heading,
          weightedFont(type.heading.fontFamily, "medium"),
          { color, fontVariant: ["tabular-nums"] },
        ]}
      >
        {label}
      </Text>
      <View style={[styles.rule, { backgroundColor: color }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heading: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    gap: 4,
    paddingLeft: sidebarRowPadding,
    paddingRight: 10,
  },
  rule: { flex: 1, height: 1, marginLeft: 4, opacity: 0.25 },
});
