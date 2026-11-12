import { useRef, useState } from "react";
import { Text } from "react-native";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { SettingChoice, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { styles, useColors } from "../../ui/theme";
import { saveDiagnosticTrace } from "./diagnostics-trace-file";

export function DiagnosticsTracing({
  computer,
  onRefresh,
}: {
  computer: ui.ComputerDiagnostics;
  onRefresh(): Promise<void>;
}) {
  const c = useColors();
  const { client } = useSession();
  const [minutes, setMinutes] = useState("5");
  const [process, setProcess] = useState("gateway");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [local, setLocal] = useState<ui.DiagnosticsTraceState>();
  const state = local ?? computer.tracing;
  const connected = computer.status === "online" && computer.tracingSupported;

  const processes = [
    { value: "gateway", label: "Gateway" },
    ...computer.links
      .filter((link) => link.kind === "worker" && link.online)
      .map((link) => ({ value: `worker:${link.targetId}`, label: link.name })),
  ];

  async function action(kind: "start" | "stop" | "export") {
    if (!client || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const request = create(ui.DiagnosticsTraceRequestSchema, {
        computerId: computer.computerId,
        processId: kind === "start" ? process : state?.processId,
        minutes: Number(minutes),
        action: kind === "export" ? "" : kind,
        leaseId: state?.leaseId,
      });

      if (kind === "export") {
        const value = await client.api.exportDiagnosticsTrace(request);
        setMessage(await saveDiagnosticTrace(toJsonString(ui.DiagnosticsTraceExportSchema, value)));
      } else {
        setLocal(await client.api.controlDiagnosticsTrace(request));
        setMessage(kind === "start" ? "Tracing started on the selected process." : "Tracing stopped.");
      }

      await onRefresh();
      setLocal(undefined);
    } catch {
      setError("Could not complete tracing. Refresh diagnostics and retry.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title="Deeper tracing">
      <Text style={[styles.workMeta, { color: c.muted }]}>
        Samples up to 1% of operations on this computer. No messages, SQL or error text.
      </Text>
      <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
        {!computer.tracingSupported
          ? "Update this computer to use tracing."
          : state?.active
            ? `Tracing until ${new Date(Number(state.expiresAtMs)).toLocaleTimeString()}. Stops automatically.`
            : "Tracing is off. Samples expire within 10 minutes after the session ends."}
      </Text>
      {!state?.active && !busy ? (
        <>
          <SettingChoice title="Process" value={process} options={processes} onChange={setProcess} />
          <SettingChoice
            title="Duration"
            value={minutes}
            options={[
              { value: "1", label: "1 minute" },
              { value: "5", label: "5 minutes" },
              { value: "10", label: "10 minutes" },
            ]}
            onChange={setMinutes}
          />
        </>
      ) : null}
      <SettingsActions>
        <Button
          title="Start deeper tracing"
          disabled={!connected || state?.active || busy}
          onPress={() => void action("start")}
        />
        <Button
          title="Stop tracing"
          disabled={!connected || !state?.active || busy}
          onPress={() => void action("stop")}
        />
        <Button
          title="Export samples"
          disabled={!connected || !state?.leaseId || busy}
          onPress={() => void action("export")}
        />
      </SettingsActions>
      {error ? <Notice error>{error}</Notice> : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          {message}
        </Text>
      ) : null}
    </SettingsGroup>
  );
}
