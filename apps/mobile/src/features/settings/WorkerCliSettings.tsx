import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { updateCheckChoices } from "@canopy/domain/update-checks";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingsRow, SettingChoice, SettingsActions } from "./SettingsGroup";
import { WorkerCliRow } from "./WorkerCliRow";
import { ResourceState, useSettingsResource } from "./resource";
import { useDateTime } from "./display";

export function WorkerCliSettings({
  worker,
  readOnly = "",
  onChanged,
}: {
  worker?: ui.Worker;
  readOnly?: string;
  onChanged?: () => void;
}) {
  const settings = useAppearance();
  const resource = useSettingsResource(`cli:${worker?.id ?? "account"}`, (api) => api.getOverview({}));
  const format = useDateTime();
  const c = useColors();
  const current = resource.data?.workers.find((w) => w.id === worker?.id) ?? worker;

  const interval = worker
    ? current?.cliUpdateCheckMinutes === undefined
      ? "inherit"
      : String(current.cliUpdateCheckMinutes)
    : String(settings.user?.cliUpdates?.intervalMinutes ?? 360);

  return (
    <ResourceState resource={resource}>
      {current && (
        <View style={{ gap: 12 }}>
          <SettingsActions>
            <Button
              secondary
              title="Check for updates"
              disabled={!current.online || !!readOnly}
              busy={resource.busy}
              onPress={() => void resource.run((api) => api.checkCliUpdates({ workerId: current.id })).then(onChanged)}
            />
          </SettingsActions>
          {current.cliTools.map((item) => (
            <WorkerCliRow
              key={item.tool?.provider}
              item={item}
              disabled={resource.busy || !!readOnly || !current.online}
              onInstall={() =>
                void resource
                  .run((api) => api.installCli({ workerId: current.id, provider: item.tool!.provider }))
                  .then(onChanged)
              }
            />
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
      <SettingChoice
        title={worker ? "Update checks" : "Agent CLI update check frequency"}
        description={
          worker
            ? "Override how often this worker checks for new releases."
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
            void resource
              .run((api) =>
                api.setWorkerCliUpdateSettings({
                  workerId: worker.id,
                  expectedConfigVersion: current!.configVersion,
                  ...(value !== "inherit" && { intervalMinutes: Number(value) }),
                }),
              )
              .then(onChanged);
        }}
      />
      {current && (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Last checked {format(current.cliUpdatesCheckedAt?.seconds)} · Next check{" "}
          {current.effectiveCliUpdateCheckMinutes === 0
            ? "manual only"
            : format(current.cliUpdatesNextCheckAt?.seconds)}
        </Text>
      )}
    </ResourceState>
  );
}
