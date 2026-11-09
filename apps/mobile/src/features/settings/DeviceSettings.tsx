import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice, Sheet } from "../../ui/components";
import { QrCode } from "../../ui/QrCode";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { useDateTime } from "./display";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

function useDeviceSettings() {
  const resource = useSettingsResource("GetMobileDevices", (api) => api.getMobileDevices({}));
  const { client, session, forget } = useSession();
  const [invitation, setInvitation] = useState<ui.CreateMobilePairingResponse>();
  const [now, setNow] = useState(Date.now);
  const format = useDateTime();
  const data = resource.data;
  const current = data?.pairings.find((p) => p.id === invitation?.pairing?.id) ?? invitation?.pairing;
  const seconds = Math.max(0, Math.ceil(Number(current?.expiresAt?.seconds ?? 0n) - now / 1000));
  const usable = seconds > 0 && !current?.usedAt && !current?.revokedAt;
  // Pairings and revocations arrive as overview events (shared read); the countdown is local.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      if (invitation?.pairing) void client?.api.revokeMobilePairing({ id: invitation.pairing.id }).catch(() => {});
    },
    [client, invitation],
  );

  async function pair(desktop: boolean) {
    const result = await resource.run(async (api) => {
      const network = await api.getNetworkAccess({});

      if (!network.enabled) await api.updateNetworkAccess({ action: "set_enabled", enabled: true });

      return desktop ? api.createDesktopPairing({}) : api.createMobilePairing({});
    });

    if (result) setInvitation(result);
  }

  async function revoke(id: string) {
    const result = await resource.run((api) => api.revokeMobileDevice({ id }));

    if (result && id === session?.deviceId) {
      await forget();
      router.replace("/pair");
    }
  }

  return {
    resource,
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
  const { resource, data, session, pair, revoke, format, now } = state;

  return (
    <ResourceState resource={resource}>
      <Notice>Your Canopy, with you. Pair once and connect on any Wi-Fi or VPN you share with this computer.</Notice>
      <Button variant="primary" title="Pair a phone" busy={resource.busy} onPress={() => void pair(false)} />
      <Button title="Pair a desktop app" disabled={resource.busy} onPress={() => void pair(true)} />
      <SettingsGroup title="Paired devices">
        <SettingsSkeletonRows controls />
        {data?.devices.map((device) => (
          <SettingsRow
            key={device.id}
            title={device.name}
            description={`${device.clientKind === "desktop" ? "Desktop app · " : ""}${device.platform} · ${device.pairingVersion < 2 ? "Pair again to use this computer's secure network connection." : device.revokedAt ? "Revoked" : device.lastSeenAt ? `Last seen ${format(device.lastSeenAt.seconds)}` : "Not connected yet"}`}
            control={
              device.pairingVersion < 2 ? (
                <Button
                  title="Pair again"
                  disabled={resource.busy}
                  onPress={() => void pair(device.clientKind === "desktop")}
                />
              ) : !device.revokedAt ? (
                <Button
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
              ) : undefined
            }
          />
        ))}
        {data && !data.devices.length && (
          <SettingsRow
            title="No devices paired yet"
            description="Pair a phone or desktop app. Revoke its access here at any time."
          />
        )}
      </SettingsGroup>
      <SettingsGroup title="Pending pairing codes">
        {data?.pairings
          .filter((p) => !p.usedAt && !p.revokedAt && Number(p.expiresAt?.seconds ?? 0n) * 1000 > now)
          .map((p) => (
            <SettingsRow
              key={p.id}
              title={p.clientKind === "desktop" ? "Waiting for a desktop app" : "Waiting for a phone"}
              description={`Expires ${format(p.expiresAt?.seconds)}`}
              control={
                <Button
                  title="Revoke code"
                  disabled={resource.busy}
                  onPress={() => void resource.run((api) => api.revokeMobilePairing({ id: p.id }))}
                />
              }
            />
          ))}
      </SettingsGroup>
      <ThisPhone state={state} />
      <PairingInvitation state={state} />
    </ResourceState>
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

  return (
    <Sheet
      visible={!!invitation}
      title={invitation?.pairing?.clientKind === "desktop" ? "Pair a desktop app" : "Pair a phone"}
      onClose={() => setInvitation(undefined)}
    >
      <Notice>
        {current?.usedAt
          ? "Device paired"
          : usable
            ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
            : "This code has expired or was revoked. Close and create a new code."}
      </Notice>
      {invitation && usable && (
        <>
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
          <Text selectable style={[styles.heading, { color: c.text, textAlign: "center" }]}>
            {invitation.code}
          </Text>
          <SettingsValue title="Addresses" value={invitation.routes?.addresses.join("\n")} />
          <SettingsValue title="Certificate fingerprint" value={invitation.routes?.fingerprint} />
          {invitation.pairing?.clientKind === "desktop" && (
            <Text selectable style={[styles.meta, { color: c.muted }]}>
              {JSON.stringify({
                code: invitation.code,
                routes: { addresses: invitation.routes?.addresses, fingerprint: invitation.routes?.fingerprint },
              })}
            </Text>
          )}
        </>
      )}
    </Sheet>
  );
}
