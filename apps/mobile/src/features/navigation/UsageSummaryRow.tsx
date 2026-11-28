import { Text, View } from "react-native";
import type { UsageTone } from "@canopy/domain/sidebar-usage";
import { accountsText, type UsageSummaryRow as Row } from "@canopy/domain/usage-summary";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { useUsageTypography } from "../providers/usage-typography";
import { usageColor } from "./usage-color";
import { UsageSummaryMeter } from "./UsageSummaryMeter";

/** A provider's limit windows share an account order, including the five-hour row for uncapped plans. */
export function UsageSummaryRow({ row, now }: { row: Row; now: number }) {
  const c = useColors();
  const type = useUsageTypography();
  const tone = (value: UsageTone) => (value === "neutral" ? c.soft : usageColor(value, c));
  const count = accountsText(row);

  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={[row.name, count, row.word].filter(Boolean).join(", ")}
        style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", rowGap: 2 }]}
      >
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
          {row.fiveHourPlaceholder.length > 0 ? (
            <UsageSummaryMeter segments={row.fiveHourPlaceholder} now={now} />
          ) : null}
          {row.shorter.map((meter) => (
            <UsageSummaryMeter key={meter.window.minutes} {...meter} now={now} />
          ))}
          <UsageSummaryMeter segments={row.segments} window={row.window} now={now} />
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
