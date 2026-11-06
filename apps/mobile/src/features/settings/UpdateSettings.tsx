import { useEffect } from "react";
import { presenceLabel } from "@canopy/domain/computer-presence";
import { presenceTime } from "../computers/presence";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function UpdateSettings() {
  const resource = useSettingsResource("updates", (api) => api.getUpdates({}));
  const data = resource.data;
  const { reload } = resource;
  useEffect(() => {
    const timer = setInterval(() => void reload(), 5000);

    return () => clearInterval(timer);
  }, [reload]);

  const change = (request: MessageInitShape<typeof ui.ManageUpdatesRequestSchema>) =>
    void resource.run((api) => api.manageUpdates(request));

  return (
    <SettingsGroup
      title="Updates"
      actions={
        <Button title="Check now" busy={resource.busy || data?.checking} onPress={() => change({ action: "check" })} />
      }
    >
      <ResourceState resource={resource}>
        <SettingsSkeletonRows rows={3} controls />
        {data && (
          <>
            {!data.gatewayBundled && <GatewayUpdate data={data} busy={resource.busy} change={change} />}
            {data.gatewayBundled && (
              <SettingsValue
                title="This Canopy app"
                value={data.app?.phase || data.gatewayVersion}
                description="Includes this computer's gateway and worker."
              />
            )}
            <RemoteUpdateRows data={data} busy={resource.busy} change={change} />
            <SettingsRow
              title="Update all"
              description={data.run?.reason}
              control={
                <Button
                  size="sm"
                  title={data.run?.state === "failed" ? "Retry update all" : "Update all"}
                  disabled={resource.busy || !data.admin || data.run?.state === "running"}
                  onPress={() => change({ action: "update_all" })}
                />
              }
            />
            {data.run?.steps.map((step, index) => (
              <SettingsValue
                key={index}
                title={`${step.label} · ${step.version}`}
                value={step.state}
                description={step.reason}
              />
            ))}
          </>
        )}
      </ResourceState>
    </SettingsGroup>
  );
}

type UpdateRowsProps = {
  data: ui.UpdatesSnapshot;
  busy: boolean;
  change: (request: MessageInitShape<typeof ui.ManageUpdatesRequestSchema>) => void;
};

function GatewayUpdate({ data, busy, change }: UpdateRowsProps) {
  return (
    <>
      <SettingsRow
        title={`Gateway ${data.gatewayVersion}`}
        description={[data.gatewayInstallKind, data.gatewayState, data.gatewayReason, data.checkError]
          .filter(Boolean)
          .join(" · ")}
        control={
          data.gatewayUpdateAvailable ? (
            <Button
              variant="primary"
              title={`Update to ${data.availableVersion}`}
              disabled={busy || !data.admin}
              onPress={() =>
                confirmAction("Update gateway", "The gateway may restart. Clients reconnect automatically.", () =>
                  change({ action: "gateway" }),
                )
              }
            />
          ) : undefined
        }
      />
      <SettingChoice
        title="Release channel"
        value={data.channel}
        disabled={busy || !data.admin}
        options={[
          { value: "stable", label: "Stable" },
          { value: "beta", label: "Beta" },
          { value: "nightly", label: "Nightly" },
        ]}
        onChange={(channel) =>
          confirmAction(
            "Change release channel",
            "A channel may contain an older version. Review the available version before installing.",
            () => change({ action: "channel", channel }),
          )
        }
      />
    </>
  );
}

function RemoteUpdateRows({ data, busy, change }: UpdateRowsProps) {
  return (
    <>
      {data.workers
        .filter((w) => !w.bundled)
        .map((worker) => (
          <SettingsRow
            key={worker.workerId}
            title={`${worker.name} · ${worker.version}`}
            description={[worker.state, worker.reason, worker.compatibility].filter(Boolean).join(" · ")}
            control={
              <Button
                title={worker.installKind === "desktop" ? "Update Canopy app" : "Update worker"}
                disabled={busy || !worker.connected || !data.admin || !!worker.reason}
                onPress={() =>
                  change({
                    action: worker.installKind === "desktop" ? "desktop" : "worker",
                    workerId: worker.workerId,
                  })
                }
              />
            }
          />
        ))}
      {data.computers.map((computer) => (
        <SettingsRow
          key={computer.nodeId}
          title={`${computer.name} · ${computer.version}`}
          description={
            computer.presence === "connected"
              ? computer.reason || "Connected"
              : presenceLabel(computer.presence, computer.presenceSinceMs, presenceTime)
          }
          control={
            <Button
              title="Check now"
              disabled={busy || !computer.remoteUpdate}
              onPress={() => change({ action: "computer_check", nodeId: computer.nodeId })}
            />
          }
        >
          <Button
            title="Update"
            disabled={busy || !computer.remoteUpdate}
            onPress={() => change({ action: "computer", nodeId: computer.nodeId })}
          />
        </SettingsRow>
      ))}
    </>
  );
}
