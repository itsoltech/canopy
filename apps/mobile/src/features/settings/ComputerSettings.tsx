import { useAppearance } from "../../state/appearance";
import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { SettingsTopics } from "./SettingsTopics";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ComputerPairing } from "./ComputerPairing";
import { ComputerMove } from "./ComputerMove";
import { SharedConfiguration } from "./SharedConfiguration";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { presenceLabel } from "@canopy/domain/computer-presence";
import { useOpenSettingsSection } from "./navigation";
import { ComputerConfigSharing } from "./ComputerConfigSharing";
import { presenceTime } from "../computers/presence";

type Operation = MessageInitShape<typeof ui.ComputerOperationRequestSchema>;

export function ComputerSettings() {
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const [pairing, setPairing] = useState(false);
  const [moving, setMoving] = useState<ui.LinkedComputer>();
  const data = resource.data;

  const names =
    data?.configGroup.filter((computer) => computer.nodeId !== data.self?.nodeId).map((computer) => computer.name) ??
    [];

  const bulkMove = useAppearance().modules.length > 1;
  const change = async (operation: Operation) => !!(await resource.run((api) => api.manageComputer(operation)));

  const direct = data?.peers.filter((computer) => !computer.viaNodeId) ?? [];

  return (
    <ResourceState resource={resource}>
      <SettingsTopics
        topics={[
          {
            id: "computers",
            label: "Linked computers",
            content: (
              <>
                <Notice>Connect your own computers. Each keeps its own gateway and data.</Notice>
                <Button
                  variant="primary"
                  title="Link a computer"
                  disabled={!data || resource.busy}
                  onPress={() => setPairing(true)}
                />
                <SettingsGroup
                  title="Linked computers"
                  description="Pairing grants full access between your computers. Only link computers you own."
                >
                  <SettingsSkeletonRows controls />
                  {data?.peers.map((computer) => (
                    <ComputerDetails
                      key={computer.nodeId}
                      computer={computer}
                      peers={data.peers}
                      busy={resource.busy}
                      change={change}
                      {...(bulkMove && { onMove: () => setMoving(computer) })}
                    />
                  ))}
                  {data && !data.peers.length && (
                    <SettingsRow
                      title="No computers linked yet"
                      description="Generate a code here, or enter a code from your other computer."
                    />
                  )}
                </SettingsGroup>
              </>
            ),
          },
          {
            id: "this-computer",
            label: "This computer",
            content: (
              <ThisComputer data={data} busy={resource.busy} loading={resource.initialLoading} change={change} />
            ),
          },
          {
            id: "sharing",
            label: "Configuration sharing",
            hidden: !direct.length && !names.length && !data?.configNotices.length,
            content: (
              <>
                {data && (
                  <SettingsRow
                    title={
                      names.length
                        ? `Shares configuration with ${names.join(", ")}`
                        : "Configuration stays on this computer."
                    }
                  />
                )}
                {direct.map((computer) => (
                  <SettingsGroup key={computer.nodeId} title={computer.displayName || computer.name}>
                    <ComputerConfigSharing
                      computer={computer}
                      busy={resource.busy}
                      onChange={(enabled) => void change({ action: "share_config", nodeId: computer.nodeId, enabled })}
                    />
                  </SettingsGroup>
                ))}
                {!!data?.configNotices.length && (
                  <SharedConfiguration notices={data.configNotices} onChanged={() => void resource.reload()} />
                )}
              </>
            ),
          },
        ]}
      />
      {pairing && (
        <ComputerPairing
          onClose={() => {
            setPairing(false);
            void resource.reload();
          }}
        />
      )}
      <Sheet
        title={`Move everything to ${moving?.displayName || moving?.name || "computer"}`}
        visible={!!moving && bulkMove}
        onClose={() => setMoving(undefined)}
      >
        {moving && bulkMove && <ComputerMove nodeId={moving.nodeId} />}
      </Sheet>
    </ResourceState>
  );
}

function ThisComputer({
  data,
  busy,
  loading,
  change,
}: {
  data?: ui.ComputersSnapshot;
  busy: boolean;
  loading: boolean;
  change: (operation: Operation) => Promise<boolean>;
}) {
  const openSettingsSection = useOpenSettingsSection();

  return (
    <>
      <SettingsGroup title="This computer">
        {loading && (
          <ComputerDetails computer={create(ui.LinkedComputerSchema, { name: " " })} self busy change={change} />
        )}
        {data?.self && <ComputerDetails computer={data.self} self busy={busy} change={change} />}
        <SettingToggle
          title="Find linked computers on this network"
          description={data?.lanDiscoveryNote || "Discover routes to computers you have already linked."}
          value={data?.lanDiscoveryEnabled ?? false}
          disabled={!data || busy}
          onChange={(enabled) => void change({ action: "lan_discovery", enabled })}
        />
        <SettingsValue title="Network discovery" value={data?.lanDiscoveryState} />
      </SettingsGroup>
      <SettingsGroup title="Network access">
        <SettingsRow
          title={data?.listenerEnabled ? "Remote access is on" : "Remote access is off"}
          description={data?.self?.addresses.join(" · ")}
          control={<Button title="Manage network access" onPress={() => openSettingsSection("network")} />}
        />
      </SettingsGroup>
    </>
  );
}

function ComputerDetails({
  computer,
  peers = [],
  self = false,
  busy,
  change,
  onMove,
}: {
  computer: ui.LinkedComputer;
  peers?: ui.LinkedComputer[];
  self?: boolean;
  busy: boolean;
  change: (r: Operation) => Promise<boolean>;
  onMove?: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const name = computer.displayName || computer.name;
  const direct = !self && !computer.viaNodeId;

  return (
    <SettingsRow
      title={name}
      description={[
        self ? "This computer" : presenceLabel(computer.status, computer.statusSinceMs, presenceTime),
        computer.connectionDirection,
        computer.viaName && `Via ${computer.viaName}`,
        computer.unavailableReason,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <SettingsValue title="Canopy version" value={computer.appVersion} />
      {!computer.viaNodeId && <SettingsValue title="Certificate fingerprint" value={computer.fingerprint} />}

      {!self && (
        <SettingsValue
          title="Last seen"
          value={computer.lastSeenMs ? new Date(Number(computer.lastSeenMs)).toLocaleString() : "Not yet connected"}
        />
      )}
      {!computer.viaNodeId && (
        <SettingsInput
          title="Computer name"
          value={name}
          busy={busy}
          onSave={(value) => change({ action: "rename", nodeId: self ? "" : computer.nodeId, name: value })}
        />
      )}
      {direct && <ComputerRoutes computer={computer} busy={busy} change={change} />}
      {direct && (
        <>
          <SettingsInput
            title="Add address"
            description="HTTPS address of this linked computer."
            value=""
            busy={busy}
            onSave={(address) => change({ action: "add_route", nodeId: computer.nodeId, address })}
          />
          {(computer.capabilities.includes("relay") || computer.shareOnwardNodeIds.length > 0) && (
            <Button title="Share onward" onPress={() => setSharing(true)} />
          )}
          {onMove && computer.capabilities.includes("move_items") && (
            <Button title="Move everything here" onPress={onMove} />
          )}
          <Button
            variant="danger"
            title="Unlink computer"
            disabled={busy}
            onPress={() =>
              confirmAction(
                "Unlink computer",
                "This removes mutual access and the pinned certificate. An offline computer learns about unlinking when it reconnects.",
                () => void change({ action: "unlink", nodeId: computer.nodeId }),
              )
            }
          />
          <Sheet title={`Share onward with ${name}`} visible={sharing} onClose={() => setSharing(false)}>
            <Notice>
              Choose which of your other computers this computer can access through this one. Nothing is shared by
              default.
            </Notice>
            {peers
              .filter((p) => p.nodeId !== computer.nodeId && !p.viaNodeId)
              .map((peer) => (
                <SettingToggle
                  key={peer.nodeId}
                  title={peer.displayName || peer.name}
                  value={computer.shareOnwardNodeIds.includes(peer.nodeId)}
                  disabled={busy}
                  onChange={(enabled) =>
                    void change({
                      action: "share_onward",
                      nodeId: computer.nodeId,
                      shareOnwardNodeIds: enabled
                        ? [...computer.shareOnwardNodeIds, peer.nodeId]
                        : computer.shareOnwardNodeIds.filter((id) => id !== peer.nodeId),
                    })
                  }
                />
              ))}
          </Sheet>
        </>
      )}
    </SettingsRow>
  );
}

function ComputerRoutes({
  computer,
  busy,
  change,
}: {
  computer: ui.LinkedComputer;
  busy: boolean;
  change: (r: Operation) => Promise<boolean>;
}) {
  return (
    <>
      {computer.routes.map((route) => (
        <SettingsRow
          key={route.address}
          title={route.address}
          description={`${route.source}${route.inUse ? " · In use" : ""}${route.latencyMs ? ` · ${route.latencyMs} ms` : ""}${route.withdrawnAtMs ? " · No longer announced" : ""}`}
        >
          <SettingsValue
            title="Last successful connection"
            value={route.lastSuccessMs ? new Date(Number(route.lastSuccessMs)).toLocaleString() : "Not yet connected"}
          />
          {route.source === "manual" && (
            <Button
              title="Remove address"
              disabled={busy}
              onPress={() => void change({ action: "remove_route", nodeId: computer.nodeId, address: route.address })}
            />
          )}
        </SettingsRow>
      ))}
    </>
  );
}
