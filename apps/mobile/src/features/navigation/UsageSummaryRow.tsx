import { Text, View } from "react-native";
import type { UsageTone } from "@canopy/domain/sidebar-usage";
import {
  accountsText,
  bindingText,
  percentLeftText,
  summaryWindowText,
  usageSummaryLabel,
  type UsageSummaryRow as Row,
} from "@canopy/domain/usage-summary";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { usageColor } from "./usage-color";

const toneOf = (left: number): UsageTone => (left <= 10 ? "danger" : left <= 30 ? "warning" : "neutral");

/**
 * One provider in the usage sheet (web: UsageSummaryRow): % left, one bar per account sized by plan units, the
 * window and its reset.
 */
export function UsageSummaryRow({ row, now }: { row: Row; now: number }) {
  const c = useColors();
  const tone = (value: UsageTone) => (value === "neutral" ? c.soft : usageColor(value, c));
  const left = row.window?.percentLeft;
  const tabular = { fontVariant: ["tabular-nums" as const] };
  const count = accountsText(row);
  const fill = (value: number) => (value > 30 ? c.muted : usageColor(toneOf(value), c));

  return (
    <View accessible accessibilityLabel={usageSummaryLabel(row, now)} style={{ gap: 6, minWidth: 0 }}>
      <View style={styles.row}>
        <ProviderIcon provider={row.provider} />
        <View style={[styles.row, { flex: 1, minWidth: 0 }]}>
          <Text numberOfLines={1} style={[styles.overlayHeading, { flexShrink: 1, color: c.text }]}>
            {row.name}
          </Text>
          {count ? <Text style={[styles.overlayMeta, { color: c.muted }]}>{count}</Text> : null}
        </View>
        {row.word ? <Text style={[styles.overlayMeta, { color: tone(row.tone) }]}>{row.word}</Text> : null}
        {row.window && left !== undefined ? (
          <Text style={[styles.overlayHeading, tabular, { color: tone(toneOf(left)) }]}>
            {percentLeftText(row.window)}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 4, height: 4 }}>
        {row.window ? (
          row.segments.map((segment, index) => (
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
          ))
        ) : (
          <View style={{ flex: 1, borderRadius: 2, backgroundColor: c.agent }} />
        )}
      </View>
      <View style={[styles.row, { justifyContent: "space-between", minHeight: 18 }]}>
        <Text numberOfLines={1} style={[styles.overlayMeta, tabular, { flexShrink: 1, color: c.muted }]}>
          {row.window ? summaryWindowText(row.window, now) : ""}
        </Text>
        {row.binding ? (
          <Text style={[styles.overlayMeta, tabular, { color: tone(toneOf(row.binding.percentLeft)) }]}>
            {bindingText(row.binding)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
