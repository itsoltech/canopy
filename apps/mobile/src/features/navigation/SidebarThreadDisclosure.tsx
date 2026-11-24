import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { palette } from "@canopy/ui";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Chevron } from "../../ui/MotionViews";
import { inOut, motion, useReducedMotion } from "../../ui/motion";
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
      <Chevron open={expanded} size={16} color={working ? color : c.icon} easing={inOut} />
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

export function useSidebarDisclosureMotion(expanded: boolean) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(expanded ? 1 : 0);
  const [target, setTarget] = useState(expanded);
  const [settled, setSettled] = useState(true);

  if (target !== expanded) {
    setTarget(expanded);
    setSettled(false);
  }

  useEffect(() => {
    const end = expanded ? 1 : 0;

    if (reduced) {
      progress.set(end);
      setSettled(true);

      return;
    }

    let current = true;

    const finish = () => {
      if (current) setSettled(true);
    };

    progress.set(
      withTiming(end, { duration: motion.fast, easing: inOut }, (finished) => {
        if (finished) scheduleOnRN(finish);
      }),
    );

    return () => {
      current = false;
      cancelAnimation(progress);
    };
  }, [expanded, progress, reduced]);

  const animating = !reduced && !settled;

  return { expanded, progress, animating, rendered: expanded || animating };
}

/** One progress value moves the whole section while each thread keeps its virtualized list cell. */
export function SidebarDisclosureRow({
  disclosure,
  children,
  ...animation
}: Pick<ComponentProps<typeof Animated.View>, "entering" | "exiting" | "layout"> & {
  disclosure?: ReturnType<typeof useSidebarDisclosureMotion>;
  children: ReactNode;
}) {
  const height = useSharedValue(0);
  const progress = disclosure?.progress;
  const hidden = disclosure?.expanded === false;

  const reveal = useAnimatedStyle(() => {
    const fraction = progress?.get() ?? 1;

    return { height: fraction === 1 ? "auto" : height.get() * fraction, opacity: fraction };
  });

  return (
    <Animated.View {...animation}>
      <Animated.View
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        pointerEvents={hidden ? "none" : "auto"}
        style={[disclosure?.animating && styles.clip, reveal]}
      >
        <View
          onLayout={disclosure ? (event) => height.set(event.nativeEvent.layout.height) : undefined}
          style={styles.body}
        >
          {children}
        </View>
      </Animated.View>
    </Animated.View>
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
  clip: { overflow: "hidden" },
  body: { paddingTop: 2 },
});
