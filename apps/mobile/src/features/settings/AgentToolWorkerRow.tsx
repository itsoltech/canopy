import type { AgentTool, ui } from "@canopy/contracts";
import { workerTool, type ToolWorker } from "@canopy/domain/agent-tool-settings";
import { Text } from "react-native";
import { Button } from "../../ui/components";
import { Switch } from "../../ui/Switch";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsRow } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";

function installStatus(item: ui.WorkerAgentTool | undefined) {
  const info = item?.tool;

  if (!info) return "Not checked";

  if (info.install?.state === "running") return "Installing…";

  if (!info.ready && info.install?.state === "failed") return "Install failed";

  if (item?.action === "update") return "Update available";

  if (info.ready) return "Ready";

  return info.installed ? "Needs setup" : "Not installed";
}

export function AgentToolWorkerRow({
  entry,
  tool,
  name,
  busy,
  onEnable,
  onInstall,
}: {
  entry: ToolWorker;
  tool: AgentTool;
  name: string;
  busy: boolean;
  onEnable: (value: boolean) => void;
  onInstall: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const { worker, computer, readOnly } = entry;
  const item = workerTool(worker, tool);
  const info = item?.tool;
  const running = info?.install?.state === "running";
  const failed = !info?.ready && info?.install?.state === "failed";
  const details = [info?.detail, info?.path, ...(item?.log ?? []), info?.install?.error].filter(Boolean).join("\n");
  const disabled = busy || !item || !!readOnly;

  const status = [computer, worker.os, !worker.online && "Offline", installStatus(item), info?.version]
    .filter(Boolean)
    .join(" · ");

  const reason =
    readOnly || (!worker.online ? "Connect this worker to enable access or install tools." : "") || item?.blockedReason;

  const installLabel =
    item?.action === "update"
      ? "Update tool"
      : failed
        ? "Retry install"
        : info?.installed
          ? "Repair tool"
          : "Install tool";

  return (
    <SettingsRow
      title={worker.name}
      description={status}
      inlineControl
      control={
        <Switch
          size="sm"
          label={`Use ${name} on ${worker.name}`}
          value={!!item?.enabled}
          disabled={disabled || (!worker.online && !item?.enabled)}
          onChange={onEnable}
        />
      }
    >
      {reason ? <Text style={[type.meta, { color: c.muted }]}>{reason}</Text> : null}
      {(item?.action || running) && !readOnly ? (
        <Button
          size="sm"
          title={installLabel}
          busy={running}
          disabled={disabled || !worker.online || !!item?.blockedReason}
          onPress={onInstall}
        />
      ) : null}
      {details ? (
        <SettingsDisclosure
          viewKey={`agent-tool:${tool}:${worker.id}`}
          title={item?.log.length || info?.install?.error ? "Show install log" : "Show tool details"}
        >
          <Text selectable style={[type.mono, { color: c.soft }]}>
            {details}
          </Text>
        </SettingsDisclosure>
      ) : null}
    </SettingsRow>
  );
}
