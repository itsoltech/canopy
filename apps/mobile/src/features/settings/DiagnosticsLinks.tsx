import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  METRIC_DEFINITIONS,
  workerMetricGroups,
  syncMetricGroups,
  metricRows,
  measuresObserved,
} from "@canopy/domain/diagnostics";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { EvidenceRows } from "./DiagnosticsMetrics";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsLinks({ computer }: { computer: ui.ComputerDiagnostics }) {
  const c = useColors();

  if (!computer.detailsAvailable || !computer.links.length) return null;

  return (
    <SettingsGroup title="Workers and synchronization">
      {computer.links.map((link) => (
        <SettingsDisclosure
          key={`${link.kind}:${link.targetId}`}
          title={`${link.name} · ${link.kind === "worker" ? "Worker" : "Linked computer"} · ${link.online ? "Online" : "Offline · Last known data"}`}
        >
          {!link.measuresSupported ? (
            <Text style={[styles.workMeta, { color: c.muted }]}>
              Update this computer to measure worker and synchronization health.
            </Text>
          ) : (
            <>
              <Text style={[styles.workMeta, { color: c.muted }]}>
                {link.kind === "worker"
                  ? "Turn timings include the agent CLI, tools and inference. Resource values cover the worker process."
                  : "Mirror lag runs from local detection to local commit. An unknown backlog is not zero."}
              </Text>
              {(link.kind === "worker" ? workerMetricGroups : syncMetricGroups).map((group) => {
                const measures = link.measures.filter(
                  (row) => METRIC_DEFINITIONS.get(row.metricId)?.group === group.id,
                );

                return measures.length ? (
                  <SettingsDisclosure
                    key={group.id}
                    title={`${group.title}${measuresObserved(link.measures, group.id) ? ` · ${measuresObserved(link.measures, group.id)}` : ""}`}
                  >
                    {measures.map((measure) => (
                      <View key={measure.metricId} style={{ gap: 8 }}>
                        <Text style={[styles.chrome, { color: c.text }]}>
                          {METRIC_DEFINITIONS.get(measure.metricId)?.name}
                        </Text>
                        <EvidenceRows rows={metricRows(measure)} />
                        {measure.incomplete ? (
                          <Text style={[styles.workMeta, { color: c.muted }]}>Some measurements are missing.</Text>
                        ) : null}
                      </View>
                    ))}
                  </SettingsDisclosure>
                ) : null;
              })}
              {!link.measures.length ? (
                <Text style={[styles.workMeta, { color: c.muted }]}>Not measured in this window.</Text>
              ) : null}
              {link.kind === "worker" ? (
                <Text style={[styles.workMeta, { color: c.muted }]}>
                  Replay after a worker restart can be unclassified. Agent CLI memory and provider network time are not
                  measured.
                </Text>
              ) : null}
              {link.droppedSamples ? (
                <Text style={[styles.workMeta, { color: c.muted }]}>
                  Some measurements are missing: {link.droppedSamples.toString()} dropped samples.
                </Text>
              ) : null}
            </>
          )}
        </SettingsDisclosure>
      ))}
    </SettingsGroup>
  );
}
