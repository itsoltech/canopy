import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  METRIC_DEFINITIONS,
  metricGroups,
  databaseRows,
  databaseHelp,
  histogramHelp,
  measured,
  databaseCoverage,
  groupObserved,
} from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { DiagnosticsMeasures, EvidenceRows } from "./DiagnosticsMeasures";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsDatabase({
  families,
  linked = false,
}: {
  families: ui.DiagnosticsDatabaseFamily[];
  linked?: boolean;
}) {
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
        <SettingsDisclosure
          key={family.family}
          title={`${family.family} · execute p95 ${measured(family.executeMs)} · ${family.executeMs?.samples ?? 0n} samples`}
        >
          {family.incomplete ? (
            <Text style={[styles.workMeta, { color: c.muted }]}>Some measurements are missing.</Text>
          ) : null}
          <EvidenceRows rows={databaseRows(family)} />
        </SettingsDisclosure>
      ))}
    </View>
  );
}

export function DiagnosticsMetrics({ computer }: { computer: ui.ComputerDiagnostics }) {
  const c = useColors();

  if (!computer.detailsAvailable) return null;

  return (
    <SettingsGroup title="Gateway health" description={computer.name}>
      {!computer.gatewayMeasuresSupported ? (
        <SettingsRow title="Update this computer to measure gateway health." />
      ) : (
        <>
          <Text style={[styles.workMeta, { color: c.muted }]}>{histogramHelp}</Text>
          {metricGroups.map((group) => (
            <SettingsDisclosure
              key={group.id}
              title={`${group.title} · ${groupObserved(computer, group.id)}`}
              initiallyOpen={group.id === "process"}
            >
              <DiagnosticsMeasures
                measures={computer.gatewayMeasures.filter(
                  (value) => METRIC_DEFINITIONS.get(value.metricId)?.group === group.id,
                )}
              />
            </SettingsDisclosure>
          ))}
          <Text style={[styles.workMeta, { color: c.muted }]}>{databaseCoverage(computer)}</Text>
          <DiagnosticsDatabase families={computer.database} />
        </>
      )}
    </SettingsGroup>
  );
}
