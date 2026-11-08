import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { subagentLineage } from "@canopy/domain/subagents";
import { formatCount } from "@canopy/domain/format";
import { Chevron } from "../../ui/MotionViews";
import { motion, useTween } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";
import { SubagentLineage } from "./SubagentLineage";

/** Status floats above the measured input; an empty summary takes no room. */
export function SubagentSummary({
  threads,
  obscured = false,
  style,
}: {
  threads: readonly ui.Thread[];
  obscured?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const device = useDevicePreferences();
  const open = device.values.subagentsExpanded === "on";
  const { running, waiting, finished } = subagentLineage(threads, 0, false);

  const summary = [
    "Subagents",
    ...(running ? [`${formatCount(running)} running`] : []),
    ...(finished ? [`${formatCount(finished)} finished`] : []),
  ].join(" · ");

  const needs = waiting ? `${formatCount(waiting)} ${waiting === 1 ? "needs" : "need"} input` : "";

  if (running + waiting + finished === 0) return null;

  return (
    <View style={[{ height: 44, flexShrink: 0 }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[summary, needs].filter(Boolean).join(" · ")}
        accessibilityState={{ expanded: open && !obscured }}
        accessibilityLiveRegion="polite"
        onPress={() => device.set("subagentsExpanded", open ? "off" : "on")}
        style={({ pressed }) => [
          styles.row,
          { flex: 1, paddingHorizontal: 8, borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[styles.chromeMeta, { flex: 1, minWidth: 0, color: c.muted, fontVariant: ["tabular-nums"] }]}
        >
          {summary}
        </Text>
        {needs ? (
          <Text style={[styles.chromeMeta, { color: c.warning, flexShrink: 0, fontVariant: ["tabular-nums"] }]}>
            {needs}
          </Text>
        ) : null}
        <Chevron open={open && !obscured} />
      </Pressable>
    </View>
  );
}

/** Expands above the fixed summary, outside the composer's measurement, within its keyboard-safe overlay slot. */
export function SubagentPanel({ threads, style }: { threads: readonly ui.Thread[]; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const device = useDevicePreferences();
  const open = device.values.subagentsExpanded === "on" && threads.length > 0;
  const progress = useTween(open ? 1 : 0, { duration: open ? motion.fast : motion.quick });
  // Keep the flex slot until the close finishes; an exiting, unmounted view loses its bottom anchor.
  const slot = useAnimatedStyle(() => ({ display: progress.get() === 0 ? "none" : "flex" }));

  const panel = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (progress.get() - 1) * motion.distance.micro }],
  }));

  // The stable clip contains both directions of motion, including a scrolled list and interrupted toggles.
  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[{ maxHeight: 240, minHeight: 0, flexShrink: 1, overflow: "hidden" }, style, slot]}
    >
      <Animated.View
        accessibilityLabel="Subagents"
        style={[
          {
            minHeight: 0,
            flexShrink: 1,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.overlay,
            overflow: "hidden",
          },
          panel,
        ]}
      >
        <ScrollView
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          contentContainerStyle={{ padding: 4 }}
        >
          <SubagentLineage
            threads={threads}
            onOpen={(id) => router.push({ pathname: "/thread/[id]", params: { id } })}
          />
        </ScrollView>
      </Animated.View>
    </Animated.View>
  );
}
