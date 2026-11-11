import { StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { metricsTableRows } from "@canopy/domain/diagnostics";
import { styles, useColors } from "../../ui/theme";

const table = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  name: { width: "34%", flexShrink: 1 },
  value: { width: "22%", textAlign: "right", paddingLeft: 4, fontVariant: ["tabular-nums"] },
});

export function DiagnosticsMetricsTable({ measures }: { measures: readonly ui.DiagnosticsMeasure[] }) {
  const c = useColors();
  const rows = metricsTableRows(measures);

  if (!rows.length) return null;

  return (
    <View>
      <View style={table.row}>
        <Text style={[styles.workMeta, table.name, { color: c.muted }]}>Metric</Text>
        {["Last", "Mean", "Max"].map((heading) => (
          <Text key={heading} style={[styles.workMeta, table.value, { color: c.muted }]}>
            {heading}
          </Text>
        ))}
      </View>
      {rows.map((row) => (
        <View key={row.id} style={[table.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.rule }]}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            accessibilityLabel={row.description}
            style={[styles.workMeta, table.name, { color: c.text }]}
          >
            {row.name}
            {row.incomplete ? " *" : ""}
            {row.approximate ? " ≈" : ""}
          </Text>
          <Text
            numberOfLines={1}
            accessibilityLabel={`${row.historical ? "Last known" : "Last"}: ${row.last}`}
            style={[styles.workMeta, table.value, { color: c.text }]}
          >
            {row.last}
            {row.historical ? " †" : ""}
          </Text>
          <Text numberOfLines={1} style={[styles.workMeta, table.value, { color: c.text }]}>
            {row.mean}
          </Text>
          <Text numberOfLines={1} style={[styles.workMeta, table.value, { color: c.text }]}>
            {row.max}
          </Text>
        </View>
      ))}
      {rows.some((row) => row.historical) ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>† Last known.</Text>
      ) : null}
      {rows.some((row) => row.incomplete) ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>* Some measurements are missing.</Text>
      ) : null}
      {rows.some((row) => row.approximate) ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>≈ Estimate from the last page read.</Text>
      ) : null}
    </View>
  );
}
