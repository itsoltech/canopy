import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";
import Animated from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { subagentLineage } from "@canopy/domain/subagents";
import { formatCount } from "@canopy/domain/format";
import { Chevron } from "../../ui/MotionViews";
import { useMotion, useReducedMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";
import { SubagentLineage } from "./SubagentLineage";

/** A fixed slot keeps both the measured feed reserve and composer still when agents start or finish. */
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

  return (
    <View style={[{ height: 44, flexShrink: 0 }, style]}>
      {running + waiting + finished > 0 && (
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
      )}
    </View>
  );
}

/** Expands above the fixed summary, outside the composer's measurement, within its keyboard-safe overlay slot. */
export function SubagentPanel({ threads, style }: { threads: readonly ui.Thread[]; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const device = useDevicePreferences();
  const reduced = useReducedMotion();
  const { pop } = useMotion();

  if (device.values.subagentsExpanded !== "on" || !threads.length) return null;

  return (
    <Animated.View
      entering={reduced ? undefined : pop.entering}
      exiting={reduced ? undefined : pop.exiting}
      accessibilityLabel="Subagents"
      style={[
        {
          maxHeight: 240,
          minHeight: 0,
          flexShrink: 1,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: c.line,
          backgroundColor: c.overlay,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <ScrollView keyboardShouldPersistTaps="always" keyboardDismissMode="none" contentContainerStyle={{ padding: 4 }}>
        <SubagentLineage threads={threads} onOpen={(id) => router.push({ pathname: "/thread/[id]", params: { id } })} />
      </ScrollView>
    </Animated.View>
  );
}
