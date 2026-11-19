import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { compareUsage, metricValue, type UsageData, type UsageRow, type UsageView } from "@canopy/domain/usage-report";
import { Button, Notice } from "../../ui/components";
import { font, useColors, useTypography } from "../../ui/theme";
import { UsageChoice } from "./UsageChoice";

const baseGroups = [
  { value: "providers", label: "Provider" },
  { value: "models", label: "Model" },
  { value: "days", label: "Day" },
  { value: "speeds", label: "Requested speed" },
] as const;

const activityGroups = [
  { value: "activities", label: "Activity" },
  { value: "bots", label: "Bot" },
] as const;

const workerGroup = { value: "workers", label: "Worker" } as const;

export type UsageGroup = (typeof baseGroups | typeof activityGroups)[number]["value"] | typeof workerGroup.value;

const PAGE_SIZE = 12;

export function UsageBreakdown({
  data,
  view,
  selected,
  onChange,
}: {
  data: UsageData;
  view: UsageView;
  selected: UsageGroup;
  onChange: (group: UsageGroup) => void;
}) {
  const options = [
    ...(data.supportsWorkerBreakdown && data.workers.length ? [workerGroup] : []),
    ...baseGroups,
    ...(data.supportsActivityBreakdown ? activityGroups : []),
  ];

  const group = options.some((option) => option.value === selected) ? selected : "providers";
  const rows = data[group];

  const sorted = useMemo(
    () => (group === "days" ? [...rows].reverse() : [...rows].sort((a, b) => compareUsage(a, b, view))),
    [group, rows, view],
  );

  return (
    <View style={{ gap: 8 }}>
      <UsageChoice label="Breakdown" value={group} options={options} onChange={onChange} />
      {data.hasUnattributedUsage && (group === "activities" || group === "bots") && (
        <Notice>Some usage has no recorded activity.</Notice>
      )}
      <UsageRows key={group} rows={sorted} view={view} />
    </View>
  );
}

function UsageRows({ rows, view }: { rows: UsageRow[]; view: UsageView }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const c = useColors();
  const type = useTypography();

  if (rows.length === 0) return <Notice>No usage in this breakdown.</Notice>;

  return (
    <View>
      {rows.slice(0, limit).map(({ key, label, detail, amounts }) => (
        <View
          key={key}
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            gap: 12,
            paddingVertical: 9,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: c.line,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text selectable style={[type.small, { color: c.text }]}>
              {label}
            </Text>
            {detail && (
              <Text selectable style={[type.meta, { color: c.muted }]}>
                {detail}
              </Text>
            )}
          </View>
          <Text
            selectable
            style={[
              type.small,
              {
                maxWidth: "50%",
                textAlign: "right",
                color: c.text,
                fontFamily: font.medium,
                fontVariant: ["tabular-nums"],
              },
            ]}
          >
            {amounts.reports === 0n && view === "cost" ? "No reports" : metricValue(amounts, view)}
          </Text>
        </View>
      ))}
      {rows.length > limit && (
        <Button
          title="Show more"
          variant="text"
          onPress={() => setLimit((count) => count + PAGE_SIZE)}
          style={{ alignSelf: "flex-start" }}
        />
      )}
    </View>
  );
}
