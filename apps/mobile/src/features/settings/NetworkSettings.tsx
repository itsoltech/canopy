import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { QrCode } from "../../ui/QrCode";
import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { useSession } from "../../state/session";
import { NetworkAddresses } from "./NetworkAddresses";
import { copyText } from "../viewers/useCopyText";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { AttachmentSettings } from "./AttachmentSettings";
import { AllowedNetworksSetting } from "./AllowedNetworksSetting";

const NETWORK_ACCESS_QUERY = "GetNetworkAccess";

type Change = (
  action: string,
  patch?: MessageInitShape<typeof ui.UpdateNetworkAccessRequestSchema>,
) => Promise<boolean>;

export function NetworkSettings() {
  const { queries } = useSession();
  const resource = useSettingsResource(NETWORK_ACCESS_QUERY, (api) => api.getNetworkAccess({}));
  const { data: capabilities } = useSettingsResource("GetClientCapabilities", (api) => api.getClientCapabilities({}));
  const status = resource.data ?? (resource.initialLoading ? create(ui.NetworkAccessSchema) : undefined);

  const change = async (action: string, patch: MessageInitShape<typeof ui.UpdateNetworkAccessRequestSchema> = {}) =>
    !!(await resource.run(async (api) => {
      const updated = await api.updateNetworkAccess({ ...patch, action });

      // A change can cut off this device before the follow-up read.
      queries.set(NETWORK_ACCESS_QUERY, updated, true);

      return updated;
    }));

  return (
    <ResourceState resource={resource}>
      <Notice>
        {capabilities?.linkedComputers
          ? "Pair phones and link other computers over the networks this computer makes available."
          : "Connect paired devices and remote workers over the networks this computer makes available."}
      </Notice>
      <SettingsGroup title="This computer">
        <SettingToggle
          title={
            capabilities?.linkedComputers ? "Let phones and other computers connect" : "Let devices and workers connect"
          }
          description="Only devices you pair can use the connection, and it's encrypted with this computer's own certificate. Your web interface and database stay private."
          value={status?.enabled ?? false}
          disabled={!status || resource.busy}
          onChange={(enabled) =>
            enabled
              ? void change("set_enabled", { enabled })
              : confirmAction(
                  "Turn off network access",
                  "This disconnects this phone and other remote devices. Turn it back on from this computer to reconnect.",
                  () => void change("set_enabled", { enabled }),
                )
          }
        />
        {!!status?.allowedNetworks.length && (
          <AllowedNetworksSetting
            value={status.allowedNetworks}
            busy={resource.busy}
            onApply={(allowedNetworks) => change("set_allowed_networks", { allowedNetworks })}
          />
        )}
      </SettingsGroup>
      {status && (
        <>
          {status.error ? <Notice error>{status.error}</Notice> : null}
          {status.note && status.addresses.length > 0 ? <Notice>{status.note}</Notice> : null}
          <NetworkAddresses
            status={status}
            linked={!!capabilities?.linkedComputers}
            busy={resource.busy}
            save={(hostnames) => change("set_hostnames", { hostnames })}
          />
          <TailscaleSettings status={status} busy={resource.busy} change={change} />
          <NetworkAdvanced status={status} busy={resource.busy} change={change} />
        </>
      )}
      <AttachmentSettings />
    </ResourceState>
  );
}

function NetworkAdvanced({ status, busy, change }: { status: ui.NetworkAccess; busy: boolean; change: Change }) {
  const [port, setPort] = useState<string>();
  const [failed, setFailed] = useState(false);
  const valid = !!port && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;

  const submit = async (automatic: boolean) => {
    if (await (automatic ? change("choose_port") : change("set_port", { port: Number(port) }))) setPort(undefined);
    else setFailed(true);
  };

  return (
    <>
      <SettingsGroup title="Advanced">
        <SettingsRow
          title={status.port ? `Port ${status.port}` : "Port"}
          description={
            status.portFixed
              ? "Set by this server's configuration."
              : "Chosen automatically and kept. Change it only if a firewall allows certain ports."
          }
          inlineControl
          control={
            !status.portFixed && (
              <Button
                title="Change"
                label="Change port"
                size="sm"
                disabled={busy}
                onPress={() => {
                  setPort(status.port ? String(status.port) : "");
                  setFailed(false);
                }}
              />
            )
          }
        />
        {!!status.fingerprint && (
          <SettingsRow
            title="Certificate fingerprint"
            description={status.fingerprint}
            inlineControl
            control={
              <IconButton
                icon="clipboard-document"
                size="sm"
                label="Copy fingerprint"
                onPress={() => void copyText(status.fingerprint)}
              />
            }
          />
        )}
      </SettingsGroup>
      <Sheet title="Change port" visible={port !== undefined} onClose={() => !busy && setPort(undefined)}>
        <Notice>
          Paired devices learn the new port when they connect. If this phone loses its connection, enter the new address
          to reconnect.
        </Notice>
        <Field label="Port" value={port ?? ""} keyboardType="number-pad" onChangeText={setPort} placeholder="1–65535" />
        {failed && <Notice error>Could not change the port. Check the connection and try a free port.</Notice>}
        <Button title="Pick a free port" busy={busy} onPress={() => void submit(true)} />
        <Button
          title="Use this port"
          variant="primary"
          disabled={!valid}
          busy={busy}
          onPress={() => void submit(false)}
        />
      </Sheet>
    </>
  );
}

function TailscaleSettings({ status, busy, change }: { status: ui.NetworkAccess; busy: boolean; change: Change }) {
  const ts = status.tailscale;

  const connected = ts?.state === "connected";
  const [qr, setQr] = useState(false);

  const admin = (url: string) =>
    void Linking.openURL(url).catch(() => Alert.alert("Could not open Tailscale", "Check your browser and try again."));

  return (
    <View style={{ gap: 24 }}>
      <SettingsGroup
        title="Tailscale"
        actions={<Button title="Check again" disabled={busy} onPress={() => void change("refresh_tailscale")} />}
      >
        <SettingsRow
          title="Status"
          description={
            connected
              ? ["Connected", ts.tailnet].filter(Boolean).join(" · ")
              : tailscaleStates.get(ts?.state ?? "") || "Unavailable"
          }
        />
        {connected && !ts.magicDns && (
          <SettingsRow
            title="MagicDNS is off"
            description="Turn it on to reach this computer by name."
            control={
              <Button
                size="sm"
                title="Open admin console"
                onPress={() => admin("https://login.tailscale.com/admin/dns")}
              />
            }
          />
        )}
        {connected && ts.magicDns && ts.dnsName ? <NetworkCopyValue title="MagicDNS name" value={ts.dnsName} /> : null}
        {connected &&
          [...ts.ipv4, ...ts.ipv6].map((address) => (
            <NetworkCopyValue
              key={address}
              title={address.includes(":") ? "Tailnet IPv6" : "Tailnet IPv4"}
              value={address}
            />
          ))}
      </SettingsGroup>
      {ts?.https && ts.state !== "not_installed" && (
        <SettingsGroup title="HTTPS over Tailscale">
          <SettingToggle
            title="Open Canopy over HTTPS"
            description={
              ts.https.allowedLogin
                ? `Open Canopy on devices signed in to Tailscale as ${ts.https.allowedLogin}.`
                : "Open Canopy on every device in this computer’s tailnet."
            }
            value={ts.https.enabled}
            disabled={busy || (!ts.https.enabled && !!ts.https.unavailable)}
            onChange={(enabled) => void change("set_tailscale_https", { enabled })}
          />
          {ts.https.unavailable && (
            <SettingsRow
              title="HTTPS unavailable"
              description={ts.https.unavailable}
              control={
                ts.https.adminUrl ? (
                  <Button size="sm" title="Open admin console" onPress={() => admin(ts.https?.adminUrl ?? "")} />
                ) : undefined
              }
            />
          )}
          {ts.https.error ? <Notice error>{ts.https.error}</Notice> : null}
          {ts.https.url ? (
            <SettingsRow
              title="Address"
              description={ts.https.url}
              control={
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                  <IconButton
                    icon="clipboard-document"
                    size="sm"
                    label="Copy HTTPS address"
                    onPress={() => void copyText(ts.https?.url ?? "")}
                  />
                  <Button title="Show QR code" size="sm" onPress={() => setQr(true)} />
                </View>
              }
            />
          ) : null}
          {ts.https.enabled && (
            <SettingsInput
              title="HTTPS port"
              description="Use 0 to choose automatically: 443, or 8447 when 443 is in use."
              value={ts.https.portAutomatic ? "0" : String(ts.https.port)}
              keyboardType="number-pad"
              busy={busy}
              onSave={(value) =>
                /^\d+$/.test(value) && Number(value) <= 65535
                  ? change("set_tailscale_https_port", { port: Number(value) })
                  : Promise.resolve(false)
              }
            />
          )}
        </SettingsGroup>
      )}
      {qr && !!ts?.https?.url && (
        <Sheet visible title="HTTPS address" onClose={() => setQr(false)}>
          <View accessible accessibilityLabel="QR code for this HTTPS address" style={{ alignItems: "center" }}>
            <QrCode value={ts.https.url} />
          </View>
          <NetworkCopyValue title="Address" value={ts.https.url} />
        </Sheet>
      )}
    </View>
  );
}

const tailscaleStates = new Map(
  Object.entries({
    not_installed: "Not found. Install Tailscale to reach this computer by name.",
    not_running: "Not running. Start Tailscale on this computer.",
    stopped: "Turned off. Turn on Tailscale on this computer.",
    logged_out: "Signed out. Sign in to Tailscale on this computer.",
    starting: "Starting…",
  }),
);

function NetworkCopyValue({ title, value }: { title: string; value: string }) {
  return (
    <SettingsRow
      title={title}
      description={value}
      inlineControl
      control={
        <IconButton
          icon="clipboard-document"
          size="sm"
          label={`Copy ${title.toLowerCase()}`}
          onPress={() => void copyText(value)}
        />
      }
    />
  );
}
