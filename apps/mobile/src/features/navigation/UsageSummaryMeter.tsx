import { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { usageReset } from "@canopy/domain/provider-usage";
import { usageTone } from "@canopy/domain/sidebar-usage";
import {
  fiveHourPlaceholderText,
  percentLeftText,
  segmentValueText,
  type SummarySegment,
  type SummaryWindow,
} from "@canopy/domain/usage-summary";
import { Sensitive } from "../../ui/Sensitive";
import { styles, useColors } from "../../ui/theme";
import { useUsageTypography } from "../providers/usage-typography";
import { UsageSegmentTrack } from "./UsageSegmentTrack";
import { usageColor } from "./usage-color";

const accountStatus = (segment: SummarySegment) =>
  `${segmentValueText(segment)}${segment.percentLeft === undefined ? "" : " left"}`;

/** The same weighted columns cover each window's heading, tracks and captions for touch and screen readers. */
export function UsageSummaryMeter({
  segments,
  window,
  now,
}: {
  segments: readonly SummarySegment[];
  window?: SummaryWindow;
  now: number;
}) {
  const c = useColors();
  const type = useUsageTypography();
  const [selection, setSelection] = useState<{ index: number; label: string }>();
  const selected = selection && segments[selection.index];
  const detail = selected?.label === selection?.label ? selected : undefined;
  const name = window?.name ?? "5-hour";
  const reset = window && usageReset(window, true, now);
  const total = window ? percentLeftText(window) : fiveHourPlaceholderText(segments);
  const tone = window ? usageTone(100 - window.percentLeft) : "neutral";
  const mixed = segments.some((segment) => segment.noLimit !== segments[0]?.noLimit);
  const captions = segments.length > 1 && (window !== undefined || mixed);
  const columnGap = `${Math.min(1, 20 / segments.length)}%` as const;
  const tabular = { fontVariant: ["tabular-nums" as const] };

  return (
    <View>
      <View style={{ minHeight: 44, justifyContent: "center", gap: 4 }}>
        <View
          accessible
          accessibilityLabel={[name, reset, total].filter(Boolean).join(", ")}
          style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap", rowGap: 0 }]}
        >
          <Text style={[type.section, { flexShrink: 1, color: c.soft }]}>
            {name}
            {reset ? <Text style={[type.meta, tabular, { color: c.muted }]}> · {reset}</Text> : null}
          </Text>
          <Text style={[type.section, tabular, { color: tone === "neutral" ? c.soft : usageColor(tone, c) }]}>
            {total}
          </Text>
        </View>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: "row", columnGap }}
        >
          {segments.map((segment, index) => (
            <View
              key={index}
              style={{
                flex: segment.units,
                minWidth: 0,
                gap: 2,
                borderRadius: 3,
                backgroundColor: detail === segment ? c.pressed : "transparent",
              }}
            >
              <UsageSegmentTrack segment={segment} />
              {captions ? <SegmentCaption value={segmentValueText(segment)} /> : null}
            </View>
          ))}
        </View>
        <View style={[StyleSheet.absoluteFill, { flexDirection: "row", columnGap }]}>
          {segments.map((segment, index) => {
            const expanded = detail !== undefined && index === selection?.index;
            const label = segment.sensitiveLabel ? `Account ${index + 1}` : segment.label;

            return (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={`${label}, ${name}, ${accountStatus(segment)}`}
                accessibilityState={{ expanded }}
                onPress={() => setSelection(expanded ? undefined : { index, label: segment.label })}
                style={({ pressed }) => ({
                  flex: segment.units,
                  minWidth: 0,
                  borderRadius: 4,
                  backgroundColor: pressed ? c.pressed : "transparent",
                })}
              />
            );
          })}
        </View>
      </View>
      {detail ? (
        <View style={{ marginTop: 4, paddingLeft: 8, borderLeftWidth: 2, borderColor: c.line }}>
          {detail.sensitiveLabel ? (
            <Sensitive value={detail.label} label="Account identity" style={[type.section, { color: c.text }]} />
          ) : (
            <Text selectable style={[type.section, { color: c.text }]}>
              {detail.label}
            </Text>
          )}
          <Text style={[type.meta, tabular, { color: c.soft }]}>{accountStatus(detail)}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Measure the caption in one line at the user's font size, even when its column is narrower than one digit. */
function SegmentCaption({ value }: { value: string }) {
  const type = useUsageTypography();
  const c = useColors();
  const { width: screenWidth } = useWindowDimensions();
  const [columnWidth, setColumnWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(Infinity);

  return (
    <View
      onLayout={(event) => setColumnWidth(event.nativeEvent.layout.width)}
      style={{ overflow: "hidden", alignItems: "center" }}
    >
      <View style={{ width: screenWidth, alignItems: "center" }}>
        <Text
          numberOfLines={1}
          onLayout={(event) => setTextWidth(event.nativeEvent.layout.width)}
          style={[
            type.meta,
            { opacity: textWidth <= columnWidth ? 1 : 0, color: c.muted, fontVariant: ["tabular-nums"] },
          ]}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}
