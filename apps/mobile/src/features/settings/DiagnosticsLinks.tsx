import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  METRIC_DEFINITIONS,
  workerMetricGroups,
  syncMetricGroups,
  measuresObserved,
  workerTurnHelp,
  workerResourceHelp,
  workerReplayHelp,
} from "@canopy/domain/diagnostics";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { DiagnosticsMeasures } from "./DiagnosticsMeasures";
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
                  ? workerTurnHelp
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
                    <DiagnosticsMeasures measures={measures} />
                    {group.id === "journal" ? (
                      <Text style={[styles.workMeta, { color: c.muted }]}>{workerReplayHelp}</Text>
                    ) : null}
                  </SettingsDisclosure>
                ) : null;
              })}
              {!link.measures.length ? (
                <Text style={[styles.workMeta, { color: c.muted }]}>Not measured in this window.</Text>
              ) : null}
              {link.kind === "worker" ? (
                <Text style={[styles.workMeta, { color: c.muted }]}>{workerResourceHelp}</Text>
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
