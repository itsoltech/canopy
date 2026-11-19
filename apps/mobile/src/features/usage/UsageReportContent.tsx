import { Text, View } from "react-native";
import {
  count,
  metricValue,
  shortCount,
  type UsageAmounts,
  type UsageData,
  type UsageView,
} from "@canopy/domain/usage-report";
import { Alert, EmptyState, Notice } from "../../ui/components";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { UsageBreakdown, type UsageGroup } from "./UsageBreakdown";
import { UsageSources } from "./UsageSources";

export function UsageReportContent({
  data,
  view,
  group,
  onGroupChange,
}: {
  data: UsageData;
  view: UsageView;
  group: UsageGroup;
  onGroupChange: (group: UsageGroup) => void;
}) {
  return (
    <>
      {data.partial && (
        <Alert tone="warning" title="Partial coverage">
          Some usage or costs may be missing. Check the recording sources below.
        </Alert>
      )}
      {data.totals.reports === 0n ? (
        <EmptyState title="No usage recorded" description="Choose a different period or provider." />
      ) : (
        <>
          <UsageTotals totals={data.totals} view={view} />
          <UsageBreakdown data={data} view={view} selected={group} onChange={onGroupChange} />
        </>
      )}
      <UsageSources computers={data.computers} />
    </>
  );
}

function UsageTotals({ totals, view }: { totals: UsageAmounts; view: UsageView }) {
  const c = useColors();
  const type = useTypography();

  const counters = [
    { label: "Input", value: totals.input },
    { label: "Output", value: totals.output },
    { label: "Cache read", value: totals.cacheRead },
    { label: "Cache write", value: totals.cacheWrite },
    { label: "Reasoning", value: totals.reasoning },
  ];

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 2 }}>
        <Text accessibilityRole="header" style={[type.body, { fontFamily: font.semibold, color: c.text }]}>
          {view === "cost" ? "Total cost" : "Total tokens"}
        </Text>
        <Text selectable style={[styles.title, { color: c.text, fontVariant: ["tabular-nums"] }]}>
          {metricValue(totals, view)}
        </Text>
        {view === "cost" && (
          <Notice>
            Usage costs may include estimates and may differ from your bill.
            {totals.unknownEffectiveCostReports > 0n &&
              ` ${count(totals.unknownEffectiveCostReports)} ${totals.unknownEffectiveCostReports === 1n ? "report lacks" : "reports lack"} a complete cost.`}
          </Notice>
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {counters.map(({ label, value }) => (
          <View
            key={label}
            style={{ flexBasis: 116, flexGrow: 1, gap: 4, padding: 10, borderRadius: 8, backgroundColor: c.recess }}
          >
            <Text style={[type.small, { color: c.muted }]}>{label}</Text>
            <Text selectable style={[type.body, { color: c.text, fontVariant: ["tabular-nums"] }]}>
              {shortCount(value)}
            </Text>
          </View>
        ))}
      </View>
      <Notice>Cache reads and writes count as input. Reasoning counts as output.</Notice>
    </View>
  );
}
