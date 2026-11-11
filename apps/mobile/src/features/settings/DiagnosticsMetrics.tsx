import { useState } from "react";
import { Text, View, Pressable } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  METRIC_DEFINITIONS,
  metricGroups,
  metricRows,
  databaseRows,
  databaseHelp,
  histogramHelp,
  measured,
  databaseCoverage,
} from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { styles, useColors } from "../../ui/theme";

function EvidenceRows({ rows }: { rows: [string, string][] }) {
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

export function DiagnosticsDatabase({
  families,
  linked = false,
}: {
  families: ui.DiagnosticsDatabaseFamily[];
  linked?: boolean;
}) {
  const [selected, setSelected] = useState("");
  const c = useColors();

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.chrome, { color: c.text }]}>
        {linked ? "DB families in this RPC" : "Slow query families"}
      </Text>
      <Text style={[styles.workMeta, { color: c.muted }]}>{databaseHelp}</Text>
      {linked ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Only queries executed within this local RPC are included. Other queries may be unclassified or omitted when
          limits are reached.
        </Text>
      ) : null}
      {!families.length ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>No measured query families in this window.</Text>
      ) : null}
      {families.map((family) => (
        <View key={family.family} style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: selected === family.family }}
            onPress={() => setSelected(selected === family.family ? "" : family.family)}
            style={{ minHeight: 48, justifyContent: "center", gap: 4 }}
          >
            <Text style={[styles.chrome, { color: c.text }]}>{family.family}</Text>
            <Text style={[styles.workMeta, { color: c.muted }]}>
              Execute p95 {measured(family.executeMs)} · {String(family.executeMs?.samples ?? 0n)} samples
            </Text>
          </Pressable>
          {family.incomplete ? (
            <Text style={[styles.workMeta, { color: c.muted }]}>Some measurements are missing.</Text>
          ) : null}
          {selected === family.family ? <EvidenceRows rows={databaseRows(family)} /> : null}
        </View>
      ))}
    </View>
  );
}

export function DiagnosticsMetrics({ computer }: { computer: ui.ComputerDiagnostics }) {
  const [expanded, setExpanded] = useState("process");
  const c = useColors();

  if (!computer.detailsAvailable) return null;

  return (
    <SettingsGroup title="Gateway health" description={computer.name}>
      {!computer.gatewayMeasuresSupported ? (
        <SettingsRow title="Update this computer to measure gateway health." />
      ) : (
        <>
          <Text style={[styles.workMeta, { color: c.muted }]}>
            {histogramHelp} Last known values describe their sample time, including restored history.
          </Text>
          {metricGroups.map((group) => (
            <View key={group.id} style={{ gap: 12 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: expanded === group.id }}
                onPress={() => setExpanded(expanded === group.id ? "" : group.id)}
                style={{ minHeight: 48, justifyContent: "center" }}
              >
                <Text style={[styles.chrome, { color: c.text }]}>{group.title}</Text>
              </Pressable>
              {expanded === group.id
                ? computer.gatewayMeasures
                    .filter((value) => METRIC_DEFINITIONS.get(value.metricId)?.group === group.id)
                    .map((measure) => (
                      <View key={measure.metricId} style={{ gap: 8 }}>
                        <Text style={[styles.chrome, { color: c.text }]}>
                          {METRIC_DEFINITIONS.get(measure.metricId)?.name}
                          {METRIC_DEFINITIONS.get(measure.metricId)?.approximate
                            ? " · Estimate from last page read"
                            : ""}
                        </Text>
                        <EvidenceRows rows={metricRows(measure)} />
                        {measure.incomplete ? (
                          <Text style={[styles.workMeta, { color: c.muted }]}>Some measurements are missing.</Text>
                        ) : null}
                      </View>
                    ))
                : null}
            </View>
          ))}
          <Text style={[styles.workMeta, { color: c.muted }]}>{databaseCoverage(computer)}</Text>
          <DiagnosticsDatabase families={computer.database} />
        </>
      )}
    </SettingsGroup>
  );
}
