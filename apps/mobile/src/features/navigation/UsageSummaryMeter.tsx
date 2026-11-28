import { useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { usageReset } from "@canopy/domain/provider-usage";
import { usageTone } from "@canopy/domain/sidebar-usage";
import {
  percentLeftText,
  segmentUsageLabel,
  segmentValueText,
  type SummarySegment,
  type SummaryWindow,
} from "@canopy/domain/usage-summary";
import { styles, useColors } from "../../ui/theme";
import { useUsageTypography } from "../providers/usage-typography";
import { UsageSegmentTrack } from "./UsageSegmentTrack";
import { usageColor } from "./usage-color";

/** Each window uses the same weighted account columns. */
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
  const name = window?.name ?? "5-hour";
  const reset = window && usageReset(window, true, now);
  const total = percentLeftText(window);
  const tone = window ? usageTone(100 - window.percentLeft) : "neutral";
  const mixed = segments.some((segment) => segment.noLimit !== segments[0]?.noLimit);
  const captions = segments.length > 1 && (window !== undefined || mixed);
  const columnGap = `${Math.min(1, 20 / segments.length)}%` as const;
  const tabular = { fontVariant: ["tabular-nums" as const] };

  return (
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
      <View style={{ flexDirection: "row", columnGap }}>
        {segments.map((segment, index) => (
          <View
            key={index}
            accessible
            accessibilityRole="text"
            accessibilityLabel={segmentUsageLabel(segment, index, name)}
            style={{ flex: segment.units, minWidth: 0, gap: 2 }}
          >
            <UsageSegmentTrack segment={segment} />
            {captions ? <SegmentCaption value={segmentValueText(segment)} /> : null}
          </View>
        ))}
      </View>
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
