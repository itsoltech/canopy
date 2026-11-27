import { Text, View } from "react-native";
import type { UsageTone } from "@canopy/domain/sidebar-usage";
import type { SummarySegment } from "@canopy/domain/usage-summary";
import { styles, useColors } from "../../ui/theme";
import { useUsageTypography } from "../providers/usage-typography";
import { usageColor } from "./usage-color";

export const toneOf = (left: number): UsageTone => (left <= 10 ? "danger" : left <= 30 ? "warning" : "neutral");

/**
 * One window of a usage sheet row (web: UsageSummaryMeter): a column per account sized by plan units, in the same
 * place in every window, and a caption. An account without this window leaves its column empty.
 */
export function UsageSummaryMeter({
  segments,
  caption,
  left,
}: {
  segments: readonly SummarySegment[];
  caption: string;
  left?: { text: string; percent: number };
}) {
  const c = useColors();
  const type = useUsageTypography();
  const tabular = { fontVariant: ["tabular-nums" as const] };
  const fill = (value: number) => (value > 30 ? c.muted : usageColor(toneOf(value), c));
  const tone = (value: UsageTone) => (value === "neutral" ? c.soft : usageColor(value, c));

  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <View style={{ flexDirection: "row", gap: 4, height: 4 }}>
        {segments.map((segment, index) =>
          segment.percentLeft === undefined ? (
            <View key={index} style={{ flexGrow: segment.units, flexBasis: 0, minWidth: 4 }} />
          ) : (
            <View
              key={index}
              style={{
                flexGrow: segment.units,
                flexBasis: 0,
                minWidth: 4,
                borderRadius: 2,
                overflow: "hidden",
                backgroundColor: c.ring,
              }}
            >
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  width: `${segment.percentLeft}%`,
                  backgroundColor: fill(segment.percentLeft),
                }}
              />
            </View>
          ),
        )}
      </View>
      <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap", rowGap: 2, minHeight: 20 }]}>
        <Text style={[type.meta, tabular, { flexShrink: 1, color: c.muted }]}>{caption}</Text>
        {left ? (
          <Text style={[type.meta, tabular, { flexShrink: 0, color: tone(toneOf(left.percent)) }]}>{left.text}</Text>
        ) : null}
      </View>
    </View>
  );
}
