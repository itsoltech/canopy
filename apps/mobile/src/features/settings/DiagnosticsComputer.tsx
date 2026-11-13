import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  findingText,
  freshness,
  health,
  measured,
  diagnosticsFindings,
  diagnosticsStatus,
  cpuSummary,
  duration,
} from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsComputer({ computer, onSelect }: { computer: ui.ComputerDiagnostics; onSelect(): void }) {
  const c = useColors();

  return (
    <SettingsGroup
      title={computer.name}
      description={`${diagnosticsStatus(computer.status)} · ${computer.appVersion || "Version unknown"}`}
    >
      <SettingsRow title={health(computer)} description={freshness(computer)} />
      {computer.droppedSamples ? (
        <SettingsRow title="Some measurements are missing" description="Limits were reached." />
      ) : null}
      <SettingsRow
        title="Gateway coverage"
        description={`${Math.floor(computer.observedSeconds / 60)} min observed · CPU: ${cpuSummary(computer)}`}
      />
      {computer.links.map((link) => (
        <SettingsRow
          key={`${link.kind}:${link.targetId}`}
          title={link.name}
          description={`${link.online ? "Online" : "Offline"} · ${link.supported ? `RTT p95 ${measured(link.rttMs)}` : "Update to measure RTT"}`}
        />
      ))}
      {computer.gaps.length ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          No data during {computer.gaps.length} {computer.gaps.length === 1 ? "period" : "periods"}.
        </Text>
      ) : null}
      {!["saved", "restoring", "not_started", ""].includes(computer.persistenceStatus) ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          History could not be saved. Live data is still available.
        </Text>
      ) : null}
      <View style={{ minHeight: 48, justifyContent: "center" }}>
        <Button title="View details" onPress={onSelect} />
      </View>
    </SettingsGroup>
  );
}

export function DiagnosticsFindings({
  computers,
  expanded,
  onExpand,
}: {
  computers: ui.ComputerDiagnostics[];
  expanded: boolean;
  onExpand(): void;
}) {
  const c = useColors();
  const findings = diagnosticsFindings(computers);

  if (!findings.length) return null;

  return (
    <SettingsGroup title="Findings">
      {findings
        .slice(0, expanded ? findings.length : 5)
        .map(({ computer, finding, title, observers, observations }) => (
          <SettingsRow
            key={`${computer.computerId}:${finding.ruleId}:${finding.subject}`}
            title={`${title} · ${finding.severity}${finding.suspended ? " · Last known finding" : ""}`}
            description={findingText(finding)}
          >
            <Text style={[styles.workMeta, { color: c.muted }]}>
              {finding.samples.toString()} samples · {Math.floor(finding.observedSeconds / 60)} min observed · Observed
              by {observers.join(", ")}
            </Text>
            {finding.ruleId === "link_slow"
              ? observations.map((observation) => (
                  <Text key={observation.id} style={[styles.workMeta, { color: c.muted }]}>
                    {observation.name}: RTT p95 {duration(observation.value)} · {observation.samples.toString()} samples
                    {" · "}
                    {Math.floor(observation.coverage / 60)} min observed · {observation.freshness}
                  </Text>
                ))
              : null}
          </SettingsRow>
        ))}
      {findings.length > 5 ? (
        <View style={{ minHeight: 48, justifyContent: "center" }}>
          <Button title={expanded ? "Show fewer" : "Show all"} onPress={onExpand} />
        </View>
      ) : null}
    </SettingsGroup>
  );
}
