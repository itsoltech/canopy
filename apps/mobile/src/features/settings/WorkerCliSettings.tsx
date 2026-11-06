import { View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { updateCheckChoices } from "@canopy/domain/update-checks";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { providerName } from "../models/catalog";
import { SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { useDateTime } from "./display";

export function WorkerCliSettings({ worker, readOnly = "" }: { worker?: ui.Worker; readOnly?: string }) {
  const settings = useAppearance();
  const resource = useSettingsResource(`cli:${worker?.id ?? "account"}`, (api) => api.getOverview({}));
  const format = useDateTime();
  const current = resource.data?.workers.find((w) => w.id === worker?.id) ?? worker;

  const interval = worker
    ? current?.cliUpdateCheckMinutes === undefined
      ? "inherit"
      : String(current.cliUpdateCheckMinutes)
    : String(settings.user?.cliUpdates?.intervalMinutes ?? 360);

  return (
    <ResourceState resource={resource}>
      <SettingChoice
        title={worker ? "CLI update checks on this worker" : "Agent CLI update check frequency"}
        description={
          worker
            ? "Override how often this worker checks for agent CLI releases."
            : "Set how often your workers check for agent CLI releases. Checks never install updates."
        }
        value={interval}
        disabled={resource.busy || settings.saving || !!readOnly}
        options={[...(worker ? [{ value: "inherit", label: "Use account" }] : []), ...updateCheckChoices]}
        onChange={(value) => {
          if (!worker)
            void settings.update({
              cliUpdates: create(ui.CliUpdateSettingsSchema, { intervalMinutes: Number(value) }),
            });
          else
            void resource.run((api) =>
              api.setWorkerCliUpdateSettings({
                workerId: worker.id,
                expectedConfigVersion: current!.configVersion,
                ...(value !== "inherit" && { intervalMinutes: Number(value) }),
              }),
            );
        }}
      />
      {current && (
        <View style={{ gap: 12 }}>
          <SettingsValue
            title="Update checks"
            value={`Last checked ${format(current.cliUpdatesCheckedAt?.seconds)} · Next check ${current.effectiveCliUpdateCheckMinutes === 0 ? "manual only" : format(current.cliUpdatesNextCheckAt?.seconds)}`}
          />
          <Button
            secondary
            title="Check for updates"
            disabled={!current.online || !!readOnly}
            busy={resource.busy}
            onPress={() => void resource.run((api) => api.checkCliUpdates({ workerId: current.id }))}
          />
          {current.cliTools.map((item) => (
            <SettingsRow
              key={item.tool?.provider}
              title={`${providerName(item.tool?.provider ?? 0)} · ${item.tool?.version || "Not installed"}`}
              description={[
                item.tool?.path,
                item.tool?.detail,
                item.managedBy,
                item.blockedReason,
                item.latest?.error,
                item.tool?.versionError,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                item.action ? (
                  <Button
                    secondary
                    title={item.action === "install" ? "Install" : "Update"}
                    disabled={
                      resource.busy || !!readOnly || !!item.blockedReason || item.tool?.install?.state === "running"
                    }
                    onPress={() =>
                      void resource.run((api) =>
                        api.installCli({ workerId: current.id, provider: item.tool!.provider }),
                      )
                    }
                  />
                ) : undefined
              }
            >
              {item.tool?.manualCommand ? (
                <SettingsValue title="Run on this computer" value={item.tool.manualCommand} />
              ) : null}
              {item.tool?.alternatives.map((alternative) => (
                <SettingsValue
                  key={alternative.path}
                  title="Alternative installation"
                  value={`${alternative.path} · ${alternative.version}`}
                />
              ))}
              {item.log.length ? <SettingsValue title="Installer output" value={item.log.join("\n")} /> : null}
            </SettingsRow>
          ))}
          {!current.cliTools.length && (
            <SettingsRow
              title={
                current.online
                  ? "This worker has not reported its CLIs. Update the worker to manage them here."
                  : "Connect the worker to see its CLIs."
              }
            />
          )}
        </View>
      )}
    </ResourceState>
  );
}
