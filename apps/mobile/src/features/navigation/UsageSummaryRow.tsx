import { Text, View } from "react-native";
import type { UsageTone } from "@canopy/domain/sidebar-usage";
import {
  accountsText,
  percentLeftText,
  summaryWindowText,
  usageSummaryLabel,
  type UsageSummaryRow as Row,
} from "@canopy/domain/usage-summary";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { useUsageTypography } from "../providers/usage-typography";
import { usageColor } from "./usage-color";
import { UsageSummaryMeter } from "./UsageSummaryMeter";

/**
 * One provider in the usage sheet (web: UsageSummaryRow): a bar per window with its reset and % left. Each shorter
 * window some account reports (e.g. 5-hour) sits above the main bar, each account's column in the same place.
 */
export function UsageSummaryRow({ row, now }: { row: Row; now: number }) {
  const c = useColors();
  const type = useUsageTypography();
  const tone = (value: UsageTone) => (value === "neutral" ? c.soft : usageColor(value, c));
  const count = accountsText(row);

  return (
    <View accessible accessibilityLabel={usageSummaryLabel(row, now)} style={{ gap: 6, minWidth: 0 }}>
      <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", rowGap: 2 }]}>
        <View style={[styles.row, { flexGrow: 1, flexShrink: 1, flexBasis: 144, minWidth: 0 }]}>
          <ProviderIcon provider={row.provider} />
          <Text numberOfLines={1} style={[type.heading, { flexShrink: 1, minWidth: 0, color: c.text }]}>
            {row.name}
          </Text>
          {count ? <Text style={[type.meta, { flexShrink: 0, color: c.muted }]}>{count}</Text> : null}
        </View>
        {row.word ? <Text style={[type.meta, { flexShrink: 0, color: tone(row.tone) }]}>{row.word}</Text> : null}
      </View>
      {row.window ? (
        <View style={{ gap: 8, minWidth: 0 }}>
          {row.shorter.map((meter) => (
            <UsageSummaryMeter
              key={meter.window.minutes}
              segments={meter.segments}
              caption={summaryWindowText(meter.window, now)}
              left={{ text: percentLeftText(meter.window), percent: meter.window.percentLeft }}
            />
          ))}
          <UsageSummaryMeter
            segments={row.segments}
            caption={summaryWindowText(row.window, now)}
            left={{ text: percentLeftText(row.window), percent: row.window.percentLeft }}
          />
        </View>
      ) : (
        <>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: c.agent }} />
          <View style={{ minHeight: 20 }} />
        </>
      )}
    </View>
  );
}
