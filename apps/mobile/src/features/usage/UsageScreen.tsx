import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { providerName, usageReport, type UsageView } from "@canopy/domain/usage-report";
import { Alert, Button, IconButton, ScreenHeader, Segmented } from "../../ui/components";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { useColors, useTypography } from "../../ui/theme";
import type { UsageGroup } from "./UsageBreakdown";
import { UsageChoice } from "./UsageChoice";
import { UsageReportContent } from "./UsageReportContent";
import { useUsageReport } from "./useUsageReport";

const periods = [
  { value: 1, label: "Today" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

const providers = [
  { value: "", label: "All providers" },
  ...["claude", "codex", "grok"].map((value) => ({ value, label: providerName(value) })),
];

const views = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const;

export function UsageScreen() {
  const [days, setDays] = useState(30);
  const [provider, setProvider] = useState("");
  const [view, setView] = useState<UsageView>("cost");
  const [group, setGroup] = useState<UsageGroup>("providers");
  const request = useMemo(() => ({ days, provider }), [days, provider]);
  const report = useUsageReport(request);
  const response = report.status === "ready" ? report.data : undefined;
  const data = useMemo(() => response && usageReport(response, { legacyReportedCost: true }), [response]);
  const loading = report.status === "loading";
  const c = useColors();
  const type = useTypography();

  return (
    <ScreenFrame
      fullWindow
      header={
        <ScreenHeader
          title="Usage"
          right={
            (loading || report.status === "ready") && (
              <IconButton
                icon="arrow-path"
                label="Refresh usage"
                busy={loading}
                onPress={() => {
                  if (report.status === "ready") report.reload();
                }}
              />
            )
          }
        />
      }
    >
      <ScreenScroll>
        {(loading || data) && (
          <View style={{ gap: 12 }}>
            <Segmented options={views} value={view} onChange={setView} style={{ width: "100%", maxWidth: 300 }} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <View style={{ flexBasis: 168, flexGrow: 1, minWidth: 0 }}>
                <UsageChoice label="Period" value={days} options={periods} onChange={setDays} />
              </View>
              <View style={{ flexBasis: 168, flexGrow: 1, minWidth: 0 }}>
                <UsageChoice label="Provider" value={provider} options={providers} onChange={setProvider} />
              </View>
            </View>
            <Text style={[type.small, { color: c.muted }]}>Periods include today and use UTC.</Text>
          </View>
        )}
        {loading && (
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Loading usage"
            accessibilityState={{ busy: true }}
            style={{ padding: 24, alignItems: "center" }}
          >
            <ActivityIndicator color={c.accent} />
          </View>
        )}
        {report.status === "unavailable" && (
          <View style={{ gap: 8, alignItems: "flex-start" }}>
            <Alert title="Usage unavailable">Update Canopy on your gateway to use this report.</Alert>
            <Button title="Check again" onPress={report.reload} />
          </View>
        )}
        {report.status === "error" && (
          <View style={{ gap: 8, alignItems: "flex-start" }}>
            <Alert tone="error" title="Could not load usage">
              Check the gateway connection, then retry.
            </Alert>
            <Button title="Retry" onPress={report.reload} />
          </View>
        )}
        {data && <UsageReportContent data={data} view={view} group={group} onGroupChange={setGroup} />}
      </ScreenScroll>
    </ScreenFrame>
  );
}
