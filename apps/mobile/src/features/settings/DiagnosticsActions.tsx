import { useRef, useState } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Sheet, Button, Notice } from "../../ui/components";
import { SettingChoice, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { DiagnosticsReport } from "./DiagnosticsReport";
import { diagnosticsEpochs } from "./diagnostics-resource";
import { mobileMeasurements } from "./client-diagnostics";
import { styles, useColors } from "../../ui/theme";
import { DiagnosticsLogs } from "./DiagnosticsLogs";
import { DiagnosticsTracing } from "./DiagnosticsTracing";

export function DiagnosticsActions({
  computers,
  range,
  computer,
  onReset,
}: {
  computers: ui.ComputerDiagnostics[];
  range: number;
  computer: ui.ComputerDiagnostics | undefined;
  onReset(): Promise<void>;
}) {
  const c = useColors();
  const { client, queries } = useSession();
  const [report, setReport] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [process, setProcess] = useState("gateway");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const running = useRef(false);
  const [logsJobId, setLogsJobId] = useState("");

  const processes = [
    { value: "gateway", label: "Gateway" },
    ...(computer?.links ?? [])
      .filter((link) => link.kind === "worker" && link.online)
      .map((link) => ({ value: `worker:${link.targetId}`, label: link.name })),
  ];

  async function reset() {
    if (!client || !computer || running.current) return;
    const target = computer;
    running.current = true;
    setBusy(true);
    setError("");

    try {
      const receipt = await client.api.resetDiagnostics({
        computerId: target.computerId,
        processId: process,
        epoch: target.epoch,
        actionId: Crypto.randomUUID(),
      });

      diagnosticsEpochs.reset(target.computerId, receipt.epoch, receipt.epochStartedAtMs);
      queries.forget((key) => key.startsWith("GetDiagnostics:") || key.startsWith("GetComputerDiagnostics:"));

      if (target.computerId === computers[0]?.computerId) mobileMeasurements.clear(receipt.epoch);
      setResetting(false);
      setMessage("Counters reset.");
      await onReset();
    } catch {
      setError("Could not reset counters. Refresh diagnostics and retry.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsGroup title="Report and actions">
        <SettingsActions>
          <Button
            title="Prepare report"
            onPress={() => {
              setMessage("");
              setReport(true);
            }}
          />
          <Button
            title="Reset counters"
            disabled={!computer || computer.status !== "online" || computer.restoring}
            onPress={() => {
              setProcess("gateway");
              setError("");
              setMessage("");
              setResetting(true);
            }}
          />
        </SettingsActions>
        {message ? (
          <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
            {message}
          </Text>
        ) : null}
      </SettingsGroup>
      <DiagnosticsLogs computers={computers} onReady={setLogsJobId} />
      {computer ? <DiagnosticsTracing key={computer.computerId} computer={computer} onRefresh={onReset} /> : null}
      {report ? (
        <DiagnosticsReport computers={computers} range={range} logsJobId={logsJobId} onClose={() => setReport(false)} />
      ) : null}
      <Sheet
        title="Reset counters?"
        visible={resetting}
        onClose={() => {
          if (!busy) setResetting(false);
        }}
      >
        <View style={{ gap: 12 }}>
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Start a new diagnostics baseline for {computer?.name || "this computer"}.
          </Text>
          <SettingChoice title="Process" value={process} options={processes} onChange={setProcess} />
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Clears this process’s diagnostic history and findings. Running work, live gauges and runtime governor limits
            continue.
          </Text>
          {error ? <Notice error>{error}</Notice> : null}
          <SettingsActions>
            <Button title="Cancel" disabled={busy} onPress={() => setResetting(false)} />
            <Button title="Reset counters" busy={busy} onPress={() => void reset()} />
          </SettingsActions>
        </View>
      </Sheet>
    </>
  );
}
