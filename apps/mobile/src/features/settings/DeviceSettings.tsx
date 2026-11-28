import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice, Sheet } from "../../ui/components";
import { QrCode } from "../../ui/QrCode";
import { styles, useColors } from "../../ui/theme";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { useDateTime } from "./display";
import { SettingsTopics } from "./SettingsTopics";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { useLiveTime } from "../../ui/time";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { useCopyText } from "../viewers/useCopyText";
import { useOpenSettingsSection } from "./navigation";

function useDeviceSettings() {
  const resource = useSettingsResource("GetMobileDevices", (api) => api.getMobileDevices({}));
  const { client, session, forget, unpair } = useSession();
  const network = useSettingsResource("GetNetworkAccess", (api) => api.getNetworkAccess({}));
  const [invitation, setInvitation] = useState<ui.CreateMobilePairingResponse>();

  const now = useLiveTime(
    !!invitation || !!resource.data?.pairings.some((pairing) => !pairing.usedAt && !pairing.revokedAt),
  );

  const format = useDateTime();
  const data = resource.data;
  const current = data?.pairings.find((p) => p.id === invitation?.pairing?.id) ?? invitation?.pairing;
  const seconds = Math.max(0, Math.ceil(Number(current?.expiresAt?.seconds ?? 0n) - now / 1000));
  const usable = seconds > 0 && !current?.usedAt && !current?.revokedAt;
  // Pairings and revocations arrive as overview events (shared read); the countdown is local.
  useEffect(
    () => () => {
      if (invitation?.pairing) void client?.api.revokeMobilePairing({ id: invitation.pairing.id }).catch(() => {});
    },
    [client, invitation],
  );

  async function pair(desktop: boolean) {
    const result = await resource.run(async (api) => {
      const status = await api.getNetworkAccess({});

      if (status.state !== "on") {
        const updated = await api.updateNetworkAccess({ action: "set_enabled", enabled: true });
        void network.reload();

        if (updated.state !== "on") throw new Error("Network access is unavailable.");
      }

      return desktop ? api.createDesktopPairing({}) : api.createMobilePairing({});
    });

    if (result) setInvitation(result);
  }

  async function revoke(id: string) {
    if (id === session?.deviceId) {
      const result = await resource.run(async () => {
        await unpair();

        return true;
      });

      if (result) router.replace("/pair");

      return;
    }

    await resource.run((api) => api.revokeMobileDevice({ id }));
  }

  return {
    resource,
    network,
    session,
    forget,
    invitation,
    setInvitation,
    now,
    format,
    data,
    current,
    seconds,
    usable,
    pair,
    revoke,
  };
}

export function DeviceSettings() {
  const state = useDeviceSettings();

  return (
    <ResourceState resource={state.resource}>
      <SettingsTopics
        topics={[
          { id: "pairing", label: "Pairing", content: <DevicePairing state={state} /> },
          {
            id: "device-access",
            label: "Device access",
            content: (
              <>
                <PairedDevices state={state} />
                <ThisPhone state={state} />
              </>
            ),
          },
        ]}
      />
      <PairingInvitation state={state} />
    </ResourceState>
  );
}

function DevicePairing({ state }: { state: ReturnType<typeof useDeviceSettings> }) {
  const openSettingsSection = useOpenSettingsSection();
  const { resource, data, network, pair, now, format } = state;

  const pending = data?.pairings.filter(
    (p) => !p.usedAt && !p.revokedAt && Number(p.expiresAt?.seconds ?? 0n) * 1000 > now,
  );

  const disabled = !data || resource.busy || network.busy || !network.data;
  const c = useColors();

  return (
    <>
      <Text style={[styles.meta, { color: c.muted }]}>
        Pair once and connect on any Wi-Fi or VPN you share with this computer.
      </Text>
      <SettingsActions>
        <Button title="Pair a desktop app" disabled={disabled} onPress={() => void pair(true)} />
        <Button
          variant="primary"
          multiline
          title={network.data?.state === "off" ? "Turn on network access and pair a phone" : "Pair a phone"}
          disabled={disabled}
          onPress={() => void pair(false)}
        />
      </SettingsActions>
      <ResourceState resource={network}>
        <SettingsGroup>
          <SettingsRow
            title={
              network.data?.state === "on"
                ? "Network access is on"
                : network.data?.state === "error"
                  ? "Network access can’t start"
                  : network.data?.state === "off"
                    ? "Network access is off"
                    : "Network access"
            }
            description={
              network.data?.error ||
              network.data?.note ||
              network.data?.addresses.map((address) => address.origin).join("\n")
            }
            control={
              <SettingsActions>
                {network.data?.state === "off" && (
                  <Button
                    title="Turn on"
                    size="sm"
                    disabled={network.busy || resource.busy}
                    onPress={() =>
                      void network.run((api) => api.updateNetworkAccess({ action: "set_enabled", enabled: true }))
                    }
                  />
                )}
                <Button
                  title="Manage"
                  size="sm"
                  variant="ghost"
                  label="Manage network access"
                  onPress={() => openSettingsSection("network")}
                />
              </SettingsActions>
            }
          />
        </SettingsGroup>
      </ResourceState>
      {!!pending?.length && (
        <SettingsGroup title="Pending pairing codes">
          {pending.map((p) => (
            <SettingsRow
              key={p.id}
              title={p.clientKind === "desktop" ? "Waiting for a desktop app" : "Waiting for a phone"}
              description={`Expires ${format(p.expiresAt?.seconds)}`}
              control={
                <Button
                  title="Revoke code"
                  size="sm"
                  variant="ghost"
                  disabled={resource.busy}
                  onPress={() => void resource.run((api) => api.revokeMobilePairing({ id: p.id }))}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}
    </>
  );
}

function PairedDevices({ state }: { state: ReturnType<typeof useDeviceSettings> }) {
  const { data, resource, pair, revoke, session, format } = state;
  const active = data?.devices.filter((device) => !device.revokedAt) ?? [];
  const revoked = data?.devices.filter((device) => device.revokedAt) ?? [];

  return (
    <SettingsGroup title="Paired devices">
      <SettingsSkeletonRows controls />
      {active.map((device) => (
        <SettingsRow
          key={device.id}
          title={device.name}
          description={`${device.clientKind === "desktop" ? "Desktop app · " : ""}${device.platform} · ${device.pairingVersion < 2 ? "Pair again to use this computer's secure network connection." : device.lastSeenAt ? `Last seen ${format(device.lastSeenAt.seconds)}` : "Not connected yet"}`}
          control={
            device.pairingVersion < 2 ? (
              <Button
                title="Pair again"
                disabled={resource.busy}
                onPress={() => void pair(device.clientKind === "desktop")}
              />
            ) : (
              <Button
                size="sm"
                variant="ghost"
                title="Revoke access"
                disabled={resource.busy}
                onPress={() =>
                  confirmAction(
                    "Revoke access",
                    `This disconnects ${device.name}${device.id === session?.deviceId ? " (this phone)" : ""}. Pair it again to reconnect.`,
                    () => void revoke(device.id),
                  )
                }
              />
            )
          }
        />
      ))}
      {data && !active.length && (
        <SettingsRow
          title={revoked.length ? "No active devices" : "No devices paired yet"}
          description="Pair a phone or desktop app to connect it to Canopy."
        />
      )}
      {!!revoked.length && (
        <SettingsDisclosure title={`Revoked devices (${revoked.length})`} viewKey="revoked-devices">
          {revoked.map((device) => (
            <SettingsRow
              key={device.id}
              title={device.name}
              description={`${device.clientKind === "desktop" ? "Desktop app · " : ""}${device.platform}`}
            />
          ))}
        </SettingsDisclosure>
      )}
    </SettingsGroup>
  );
}

function ThisPhone({ state }: { state: ReturnType<typeof useDeviceSettings> }) {
  const { resource, session, revoke, forget } = state;

  return (
    <SettingsGroup title="This phone">
      <SettingsValue title="Gateway" value={session?.gatewayUrl} />
      <SettingsValue
        title="Device name"
        value={session?.deviceName}
        description="To change gateway or device name, unpair and pair again."
      />
      <SettingsRow
        title="Unpair this phone"
        control={
          <Button
            variant="danger"
            title="Unpair this phone"
            disabled={resource.busy}
            onPress={() =>
              confirmAction(
                "Unpair this phone",
                "This revokes access on the gateway and removes the saved key.",
                () => void revoke(session!.deviceId),
              )
            }
          />
        }
      />
      {resource.error && (
        <SettingsRow
          title="Forget pairing locally"
          description="This only removes the local key. Revoke this phone from another paired client to end its gateway access."
          control={
            <Button
              title="Forget pairing locally"
              onPress={() =>
                confirmAction(
                  "Forget this pairing",
                  "Gateway access remains active until you revoke this phone from another paired client.",
                  () => void forget().then(() => router.replace("/pair")),
                )
              }
            />
          }
        />
      )}
    </SettingsGroup>
  );
}

function PairingInvitation({ state }: { state: ReturnType<typeof useDeviceSettings> }) {
  const { invitation, setInvitation, current, usable, seconds } = state;
  const c = useColors();
  const desktop = invitation?.pairing?.clientKind === "desktop";

  const text =
    invitation && usable
      ? desktop
        ? toJsonString(ui.CreateMobilePairingResponseSchema, invitation)
        : invitation.code
      : "";

  const { copied, copy } = useCopyText(text);

  return (
    <Sheet
      visible={!!invitation}
      title={desktop ? "Pair a desktop app" : "Pair a phone"}
      onClose={() => setInvitation(undefined)}
    >
      {current?.usedAt ? (
        <Notice>Device paired.</Notice>
      ) : !invitation || !usable ? (
        <Notice>This code expired or was revoked. Close and create a new code.</Notice>
      ) : (
        <>
          <Text style={[styles.meta, { color: c.muted }]}>
            {desktop
              ? "Copy this invitation into Desktop settings → Connect to a Canopy gateway. It grants full access to your gateway’s UI."
              : "Open Canopy on your phone and scan this QR code. Use a network both devices can reach."}
          </Text>
          {!desktop && (
            <View style={{ alignItems: "center" }}>
              <QrCode
                value={JSON.stringify({
                  type: "canopy-pair",
                  version: 2,
                  addresses: invitation.routes?.addresses,
                  fingerprint: invitation.routes?.fingerprint,
                  code: invitation.code,
                })}
              />
            </View>
          )}
          <Text
            selectable
            style={[desktop ? styles.meta : styles.heading, { color: c.text, textAlign: desktop ? "left" : "center" }]}
          >
            {text}
          </Text>
          <Button
            size="sm"
            style={{ alignSelf: "center" }}
            title={copied ? "Copied" : desktop ? "Copy invitation" : "Copy code"}
            onPress={() => void copy()}
          />
          <SettingsValue title="Addresses" value={invitation.routes?.addresses.join("\n")} />
          <SettingsValue title="Certificate fingerprint" value={invitation.routes?.fingerprint} />
          <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>
            One use · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </Text>
        </>
      )}
    </Sheet>
  );
}
