import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { styles, useColors } from "../../ui/theme";
import { Button } from "../../ui/Button";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";
import { WorkerCliRow } from "../settings/WorkerCliRow";
import { useUpdates } from "./state";
import { updateHomes } from "./model";
import { UpdateDetails } from "./UpdateDetails";

export function CliUpdates({ snapshot, disabled }: { snapshot: ui.UpdatesSnapshot; disabled: boolean }) {
  const { client } = useSession();
  const { reload } = useUpdates();
  const [pending, setPending] = useState<"check" | "install">();
  const [error, setError] = useState<{ message: string; details: string }>();
  const c = useColors();

  const workers = updateHomes(snapshot).flatMap(({ name, home }) =>
    home.cliWorkers.map((worker) => ({ worker, name })),
  );

  const items = workers.flatMap(({ worker }) => worker.cliTools);

  if (!items.length) return null;

  // One word for the collapsed section: the most urgent of its rows, in the rows' own words.
  const count = items.filter((item) => item.updateAvailable).length;

  const word = items.some((item) => item.tool?.install?.state === "failed")
    ? "Failed"
    : items.some((item) => item.tool?.install?.state === "running")
      ? "Updating"
      : count
        ? `${count} available`
        : "";

  async function manage(install?: Pick<ui.InstallCliRequest, "workerId" | "provider">) {
    if (!client || pending) return;
    setPending(install ? "install" : "check");
    setError(undefined);

    try {
      if (install) await client.api.installCli(install);
      else await client.api.checkCliUpdates({}, { timeoutMs: 30_000 });
      await reload();
    } catch (cause) {
      setError({
        message: install
          ? "Could not update the agent CLI. Retry its update below."
          : "Could not check agent CLIs. Try again.",
        details: ConnectError.from(cause).rawMessage,
      });
    } finally {
      setPending(undefined);
    }
  }

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
      <SettingsDisclosure title={`Agent CLIs · ${items.length}${word ? ` · ${word}` : ""}`}>
        <Button
          title="Check for updates"
          size="sm"
          disabled={disabled || !!pending}
          busy={pending === "check"}
          onPress={() => void manage()}
        />
        {error ? (
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
              {error.message}
            </Text>
            <UpdateDetails text={error.details} />
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
                disabled={disabled || !!pending || !worker.online}
                onInstall={() => item.tool && void manage({ workerId: worker.id, provider: item.tool.provider })}
              />
            ))}
          </View>
        ))}
      </SettingsDisclosure>
    </View>
  );
}
