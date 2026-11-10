import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { findingText, freshness, health, measured, diagnosticsFindings } from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsComputer({ computer, onSelect }: { computer: ui.ComputerDiagnostics; onSelect(): void }) {
  const c = useColors();

  return (
    <SettingsGroup
      title={computer.name}
      description={`${computer.status} · ${computer.appVersion || "Version unknown"}`}
    >
      <SettingsRow title={health(computer)} description={freshness(computer)} />
      {computer.droppedSamples ? (
        <SettingsRow title="Some measurements are missing" description="Limits were reached." />
      ) : null}
      <SettingsRow
        title="Gateway coverage"
        description={`${Math.floor(computer.observedSeconds / 60)} min observed · CPU: Not measured`}
      />
      {computer.links.map((link) => (
        <SettingsRow
          key={`${link.kind}:${link.targetId}`}
          title={link.name}
          description={`${link.online ? "Online" : "Offline"} · ${link.supported ? `RTT p95 ${measured(link.rttMs)}` : "Update to measure RTT"}`}
        />
      ))}
      {computer.gaps.length ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>No data during {computer.gaps.length} periods.</Text>
      ) : null}
      {!["saved", "restoring", "not_started", ""].includes(computer.persistenceStatus) ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          History could not be saved. Live data is still available.
        </Text>
      ) : null}
      <View style={{ minHeight: 48, justifyContent: "center" }}>
        <Button title="View calls" onPress={onSelect} />
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
      {findings.slice(0, expanded ? findings.length : 5).map(({ computer, finding, observers }) => (
        <SettingsRow
          key={`${computer.computerId}:${finding.ruleId}:${finding.subject}`}
          title={`${computer.name} · ${finding.severity}${finding.suspended ? " · Last known finding" : ""}`}
          description={findingText(finding)}
        >
          <Text style={[styles.workMeta, { color: c.muted }]}>
            {finding.samples.toString()} samples · {Math.floor(finding.observedSeconds / 60)} min observed · Observed by{" "}
            {observers.join(", ")}
          </Text>
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
