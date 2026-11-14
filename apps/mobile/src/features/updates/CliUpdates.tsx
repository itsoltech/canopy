import { useState } from "react";
import { Text, View } from "react-native";
import { Provider, type ui } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";
import { WorkerCliRow } from "../settings/WorkerCliRow";
import { useUpdates } from "./state";
import { updateHomes } from "./model";
import { UpdateDetails } from "./UpdateDetails";
import { updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";

export function CliUpdates({ snapshot, disabled }: { snapshot: ui.UpdatesSnapshot; disabled: boolean }) {
  const { client } = useSession();
  const { reload, rowStatus } = useUpdates();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const c = useColors();

  const workers = updateHomes(snapshot).flatMap(({ name, nodeId, home }) =>
    home.cliWorkers.map((worker) => ({ worker, name, nodeId })),
  );

  const items = workers.flatMap(({ worker }) => worker.cliTools);

  if (!items.length) return null;

  // One word for the collapsed section: the most urgent of its rows, in the rows' own words.
  const statuses = workers.flatMap(({ worker, nodeId }) =>
    worker.cliTools.map((item) =>
      rowStatus(
        updateTargetKey({ kind: "cli", nodeId, workerId: worker.id, provider: item.tool?.provider }),
        item.tool?.install?.state === "running"
          ? "updating"
          : item.tool?.install?.state === "failed"
            ? "failed"
            : item.updateAvailable
              ? "available"
              : "current",
      ),
    ),
  );

  const count = statuses.filter((status) => status === "available").length;

  const word = statuses.includes("failed")
    ? "Failed"
    : statuses.some(updateInProgress)
      ? "Updating"
      : statuses.includes("queued")
        ? "Queued"
        : count
          ? `${count} available`
          : statuses.includes("updated")
            ? "Updated"
            : "";

  async function install(worker: ui.Worker, item: ui.WorkerCliTool) {
    if (!client || pending || !item.tool) return;
    setPending(true);
    setError("");

    try {
      await client.api.installCli({ workerId: worker.id, provider: item.tool.provider || Provider.UNSPECIFIED });
      await reload();
    } catch (cause) {
      setError(ConnectError.from(cause).rawMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
      <SettingsDisclosure title={`Agent CLIs · ${items.length}${word ? ` · ${word}` : ""}`}>
        {error ? (
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
              Could not update the agent CLI. Retry its update below.
            </Text>
            <UpdateDetails text={error} />
          </View>
        ) : null}
        {workers.map(({ worker, name }) => (
          <View key={worker.id} style={{ gap: 6 }}>
            <Text numberOfLines={1} style={[styles.overlayHeading, { color: c.muted }]}>
              {name} · {worker.name}
            </Text>
            {worker.cliTools.map((item) => (
              <WorkerCliRow
                key={item.tool?.provider}
                item={item}
                disabled={disabled || pending || !worker.online}
                onInstall={() => void install(worker, item)}
              />
            ))}
          </View>
        ))}
      </SettingsDisclosure>
    </View>
  );
}
