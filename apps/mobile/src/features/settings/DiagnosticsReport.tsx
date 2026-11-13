import { useRef, useState } from "react";
import { Text, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ui } from "@canopy/contracts";
import { Sheet, Button, Alert } from "../../ui/components";
import { useSession } from "../../state/session";
import { SettingChoice, SettingToggle, SettingsGroup, SettingsActions } from "./SettingsGroup";
import { DiagnosticsInvestigation } from "./DiagnosticsInvestigation";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsReport({
  computers,
  range,
  onClose,
  logsJobId = "",
}: {
  computers: ui.ComputerDiagnostics[];
  range: number;
  onClose(): void;
  logsJobId?: string;
}) {
  const c = useColors();
  const { client } = useSession();
  const [ids, setIds] = useState(computers.slice(0, 16).map((computer) => computer.computerId));
  const [format, setFormat] = useState("markdown");
  const [report, setReport] = useState<ui.DiagnosticsReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const running = useRef(false);

  async function preview() {
    if (!client || running.current || !ids.length) return;
    running.current = true;
    setBusy(true);
    setError("");

    try {
      setReport(await client.api.prepareDiagnosticsReport({ computerIds: ids, windowMinutes: range, format }));
    } catch {
      setError("Could not prepare the report. Check the connection and retry.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function copy() {
    if (!report) return;

    try {
      await Clipboard.setStringAsync(report.text);
      setMessage("Report copied.");
    } catch {
      setError("Could not copy the report. Select and copy the preview instead.");
    }
  }

  return (
    <Sheet
      title="Diagnostics report"
      visible
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Text style={[styles.workMeta, { color: c.muted }]}>
        Review {range} minutes of observations before copying or sharing.
      </Text>
      {!report ? (
        <>
          <SettingsGroup>
            {computers.map((computer) => (
              <SettingToggle
                key={computer.computerId}
                title={computer.name}
                description={computer.status}
                value={ids.includes(computer.computerId)}
                disabled={ids.length >= 16 && !ids.includes(computer.computerId)}
                onChange={(checked) =>
                  setIds(checked ? [...ids, computer.computerId] : ids.filter((id) => id !== computer.computerId))
                }
              />
            ))}
            <SettingChoice
              title="Format"
              value={format}
              options={[
                { value: "markdown", label: "Markdown" },
                { value: "json", label: "JSON" },
              ]}
              onChange={setFormat}
            />
          </SettingsGroup>
          <Button title="Preview report" busy={busy} disabled={!ids.length} onPress={() => void preview()} />
        </>
      ) : (
        <>
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Names are replaced with aliases. This report contains measurements, sampling and coverage gaps.
          </Text>
          {report.omittedSections.length ? (
            <Alert tone="warning">Omitted: {report.omittedSections.join("; ")}</Alert>
          ) : null}
          <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}>
            <Text selectable accessibilityLabel="Report preview" style={[styles.workMeta, { color: c.text }]}>
              {report.text}
            </Text>
          </ScrollView>
          <SettingsActions>
            <Button title="Copy report" onPress={() => void copy()} />
            <Button title="Change selection" onPress={() => setReport(undefined)} />
          </SettingsActions>
          <DiagnosticsInvestigation report={report} logsJobId={logsJobId} />
        </>
      )}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          {message}
        </Text>
      ) : null}
    </Sheet>
  );
}
