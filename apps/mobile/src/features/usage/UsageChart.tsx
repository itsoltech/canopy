import { useState } from "react";
import { Text, View } from "react-native";
import { providerDayValue } from "@canopy/domain/usage-chart";
import { dayLabel, metricValue, type UsageDay, type UsageRow, type UsageView } from "@canopy/domain/usage-report";
import { usageSeriesColor } from "@canopy/ui/provider-icons";
import { IconButton } from "../../ui/Button";
import { font, useColors, useTypography } from "../../ui/theme";
import { UsagePlot } from "./UsagePlot";

export function UsageChart({ days, providers, view }: { days: UsageDay[]; providers: UsageRow[]; view: UsageView }) {
  const [active, setActive] = useState(days.length - 1);
  const c = useColors();
  const type = useTypography();
  const index = Math.max(0, Math.min(active, days.length - 1));
  const day = days[index];

  if (!day) return null;

  return (
    <View style={{ gap: 12, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: c.line }}>
      <Text accessibilityRole="header" style={[type.body, { fontFamily: font.semibold, color: c.text }]}>
        Daily trend
      </Text>
      <UsagePlot days={days} providers={providers} view={view} index={index} onSelect={setActive} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View accessibilityLiveRegion="polite" style={{ flex: 1, gap: 2 }}>
          <Text style={[type.small, { color: c.muted }]}>{dayLabel(day.key, true)}</Text>
          <Text
            selectable
            style={[type.body, { color: c.text, fontFamily: font.medium, fontVariant: ["tabular-nums"] }]}
          >
            {day.amounts.reports === 0n
              ? "No usage"
              : `${view === "cost" ? "Total cost" : "Total tokens"} · ${metricValue(day.amounts, view)}`}
          </Text>
        </View>
        {days.length > 1 && (
          <>
            <IconButton
              icon="chevron-left"
              label="Show previous day"
              disabled={index === 0}
              onPress={() => setActive(index - 1)}
            />
            <IconButton
              icon="chevron-right"
              label="Show next day"
              disabled={index === days.length - 1}
              onPress={() => setActive(index + 1)}
            />
          </>
        )}
      </View>
      {providers.map((provider) => (
        <View key={provider.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 12,
              height: 3,
              borderRadius: 2,
              backgroundColor: usageSeriesColor(provider.key, c.dark ? "dark" : "light"),
            }}
          />
          <Text style={[type.small, { color: c.text, flex: 1 }]}>{provider.label}</Text>
          <Text
            selectable
            style={[type.small, { color: c.muted, maxWidth: "55%", textAlign: "right", fontVariant: ["tabular-nums"] }]}
          >
            {providerDayValue(day, provider.key, view)}
          </Text>
        </View>
      ))}
    </View>
  );
}
