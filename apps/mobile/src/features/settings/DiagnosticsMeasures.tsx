import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS, metricRows } from "@canopy/domain/diagnostics";
import { DiagnosticsMetricsTable } from "./DiagnosticsMetricsTable";
import { styles, useColors } from "../../ui/theme";

export function EvidenceRows({ rows }: { rows: [string, string][] }) {
  const c = useColors();

  return (
    <View style={{ gap: 6 }}>
      {rows.map(([label, value]) => (
        <View key={label} style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
          <Text style={[styles.workMeta, { color: c.muted }]}>{label}</Text>
          <Text style={[styles.workMeta, { color: c.text, fontVariant: ["tabular-nums"] }]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

export function DiagnosticsMeasures({ measures }: { measures: readonly ui.DiagnosticsMeasure[] }) {
  const c = useColors();

  return (
    <View style={{ gap: 8 }}>
      <DiagnosticsMetricsTable measures={measures} />
      {measures
        .filter((row) => METRIC_DEFINITIONS.get(row.metricId)?.kind !== "gauge")
        .map((measure) => (
          <View key={measure.metricId} style={{ gap: 8 }}>
            <Text style={[styles.chrome, { color: c.text }]}>{METRIC_DEFINITIONS.get(measure.metricId)?.name}</Text>
            <EvidenceRows rows={metricRows(measure)} />
            {measure.incomplete ? (
              <Text style={[styles.workMeta, { color: c.muted }]}>Some measurements are missing.</Text>
            ) : null}
          </View>
        ))}
    </View>
  );
}
