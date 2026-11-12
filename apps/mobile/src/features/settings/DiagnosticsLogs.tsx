import { Linking, Platform, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { diagnosticsLogRanges, diagnosticsLogStatus, diagnosticsLogBytes } from "@canopy/domain/diagnostics";
import { Sheet, Button, Notice } from "../../ui/components";
import { SettingChoice, SettingToggle, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { styles, useColors } from "../../ui/theme";
import { useDiagnosticsLogs, type DiagnosticsLogsModel } from "./use-diagnostics-logs";

type LogViewProps = { computers: ui.ComputerDiagnostics[]; model: DiagnosticsLogsModel };

export function DiagnosticsLogs({
  computers,
  onReady,
}: {
  computers: ui.ComputerDiagnostics[];
  onReady(id: string): void;
}) {
  const c = useColors();
  const model = useDiagnosticsLogs(onReady);

  return (
    <>
      <SettingsGroup title="Logs" description="Collect redacted logs from selected computers.">
        <SettingsActions>
          <Button
            title="Collect logs"
            onPress={() => {
              model.setIds(computers.slice(0, 16).map((computer) => computer.computerId));
              model.setOpen(true);
            }}
          />
        </SettingsActions>
        {model.job ? (
          <Text style={[styles.workMeta, { color: c.muted }]}>
            {diagnosticsLogStatus(model.job.status)} · {diagnosticsLogBytes(model.job.bytes)}
          </Text>
        ) : null}
      </SettingsGroup>
      <Sheet
        visible={model.open}
        title="Collect logs"
        onClose={() => {
          if (!model.busy) model.setOpen(false);
        }}
      >
        <View style={{ gap: 12 }}>
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Secrets, paths and computer names are removed before transfer.
          </Text>
          <LogSelection computers={computers} model={model} />
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Unknown records are omitted. The archive lists missing and truncated sources.
          </Text>
          <LogProgress computers={computers} model={model} />
          <LogActions model={model} />
        </View>
      </Sheet>
    </>
  );
}

function LogSelection({ computers, model: m }: LogViewProps) {
  const c = useColors();
  const disabled = m.job?.status === "collecting";

  return (
    <>
      <SettingsGroup title="Collection">
        <SettingChoice
          title="Time range"
          value={m.hours}
          options={diagnosticsLogRanges}
          onChange={m.setHours}
          disabled={disabled}
        />
        {computers.slice(0, 16).map((computer) => (
          <SettingToggle
            key={computer.computerId}
            title={computer.name}
            description={computer.status === "online" ? "Connected" : diagnosticsLogStatus(computer.status)}
            value={m.ids.includes(computer.computerId)}
            disabled={disabled}
            onChange={(checked) =>
              m.setIds((current) =>
                checked ? [...current, computer.computerId] : current.filter((id) => id !== computer.computerId),
              )
            }
          />
        ))}
        <SettingToggle title="Include untimed records" value={m.legacy} onChange={m.setLegacy} disabled={disabled} />
      </SettingsGroup>
      {m.ids.length > 8 ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>Select fewer computers for more logs per computer.</Text>
      ) : null}
    </>
  );
}

function LogProgress({ computers, model: m }: LogViewProps) {
  const c = useColors();

  return (
    <>
      {m.job ? (
        <SettingsGroup title="Progress">
          {m.job.homes.map((home) => (
            <View key={home.computerId} style={{ gap: 4 }}>
              <Text numberOfLines={1} style={{ color: c.text }}>
                {computers.find((computer) => computer.computerId === home.computerId)?.name || home.alias}
              </Text>
              <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
                {diagnosticsLogStatus(home.status)} · {diagnosticsLogBytes(home.bytes)}
              </Text>
            </View>
          ))}
        </SettingsGroup>
      ) : null}
      {m.job?.status === "partial" ? (
        <Notice>Some sources are missing. Export the partial archive or retry failed computers.</Notice>
      ) : null}
      {m.error ? (
        <Notice error>
          {m.error}
          <Button title="Retry" onPress={() => void (m.job ? m.refresh() : m.collect())} />
        </Notice>
      ) : null}
      {m.message ? (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          {m.message}
        </Text>
      ) : null}
      {m.job ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Available for 15 minutes. Exports stay on your device.
        </Text>
      ) : null}
    </>
  );
}

function LogActions({ model: m }: { model: DiagnosticsLogsModel }) {
  const ready = m.job && ["done", "partial"].includes(m.job.status);

  return (
    <SettingsActions>
      {m.job?.status === "collecting" ? (
        <Button title="Cancel collection" disabled={m.busy} onPress={() => void m.cancel()} />
      ) : (
        <>
          {ready ? (
            <Button
              title={Platform.OS === "android" ? "Save logs" : "Share logs"}
              disabled={m.busy}
              onPress={() => void m.download()}
            />
          ) : null}
          <Button
            title={m.job?.status === "partial" ? "Retry failed" : "Collect logs"}
            disabled={m.busy || !m.ids.length}
            onPress={() =>
              void m.collect(
                m.job?.status === "partial"
                  ? m.job.homes.filter((home) => home.status !== "done").map((home) => home.computerId)
                  : m.ids,
              )
            }
          />
        </>
      )}
      {m.folder ? (
        <Button
          title="Open folder"
          onPress={() =>
            void Linking.openURL(m.folder).catch(() =>
              m.setError("Could not open this folder. Open it in your Files app."),
            )
          }
        />
      ) : null}
    </SettingsActions>
  );
}
