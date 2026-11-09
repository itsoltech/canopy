import { View } from "react-native";
import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Button, Notice } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { AttachmentSettings } from "./AttachmentSettings";

type Change = (
  action: string,
  patch?: MessageInitShape<typeof ui.UpdateNetworkAccessRequestSchema>,
) => Promise<boolean>;

export function NetworkSettings() {
  const resource = useSettingsResource("GetNetworkAccess", (api) => api.getNetworkAccess({}));
  const { data: capabilities } = useSettingsResource("GetClientCapabilities", (api) => api.getClientCapabilities({}));
  const status = resource.data ?? (resource.initialLoading ? create(ui.NetworkAccessSchema) : undefined);

  const change = async (action: string, patch: MessageInitShape<typeof ui.UpdateNetworkAccessRequestSchema> = {}) =>
    !!(await resource.run((api) => api.updateNetworkAccess({ ...patch, action })));

  return (
    <ResourceState resource={resource}>
      <Notice>
        {capabilities?.linkedComputers
          ? "Pair phones and link your other computers on any network they share with this one: Wi-Fi, Tailscale or the internet."
          : "Connect paired devices and remote workers over Wi-Fi, Tailscale or the internet."}
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
      </SettingsGroup>
      {status && (
        <>
          {status.error ? <Notice error>{status.error}</Notice> : null}
          {status.note ? <Notice>{status.note}</Notice> : null}
          <SettingsGroup
            title="Reachable at"
            description={
              capabilities?.linkedComputers
                ? "Phones and linked computers try these addresses in turn. They follow this computer from network to network."
                : "Paired devices and workers try these addresses in turn to reach this gateway."
            }
          >
            {status.addresses.map((address) => (
              <SettingsRow
                key={address.origin}
                title={address.origin}
                description={`${address.kind}${address.interfaceName ? ` · ${address.interfaceName}` : ""}`}
                control={
                  address.kind === "hostname" ? (
                    <Button
                      title={`Remove ${address.host}`}
                      disabled={resource.busy}
                      onPress={() =>
                        void change("set_hostnames", { hostnames: status.hostnames.filter((h) => h !== address.host) })
                      }
                    />
                  ) : undefined
                }
              />
            ))}
            {!status.addresses.length && (
              <SettingsRow
                title={status.state === "on" ? "No network right now" : "Not reachable"}
                description="Connect this computer to a network, or add a hostname."
              />
            )}
            <SettingsInput
              title="Hostnames"
              description="Add one hostname per line, including a forwarded port when needed."
              value={status.hostnames.join("\n")}
              multiline
              busy={resource.busy}
              onSave={(value) =>
                change("set_hostnames", {
                  hostnames: value
                    .split("\n")
                    .map((h) => h.trim())
                    .filter(Boolean),
                })
              }
            />
          </SettingsGroup>
          <TailscaleSettings status={status} busy={resource.busy} change={change} />
          <NetworkAdvanced status={status} busy={resource.busy} change={change} />
        </>
      )}
      <AttachmentSettings />
    </ResourceState>
  );
}

function NetworkAdvanced({ status, busy, change }: { status: ui.NetworkAccess; busy: boolean; change: Change }) {
  return (
    <SettingsGroup title="Advanced">
      <SettingsValue
        title={status.port ? `Port ${status.port}` : "Port"}
        description={
          status.portFixed
            ? "Set by this server's configuration."
            : "Chosen automatically and kept. Change it only if a firewall allows certain ports."
        }
        value={status.port ? String(status.port) : "Automatic"}
      />
      {!status.portFixed && (
        <>
          <SettingsInput
            title="Port"
            value={String(status.port)}
            keyboardType="number-pad"
            busy={busy}
            onSave={(value) =>
              /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
                ? change("set_port", { port: Number(value) })
                : Promise.resolve(false)
            }
          />
          <SettingsRow
            title="Choose automatically"
            control={<Button title="Pick a free port" disabled={busy} onPress={() => void change("choose_port")} />}
          />
        </>
      )}
      <SettingsValue title="Certificate fingerprint" value={status.fingerprint} />
    </SettingsGroup>
  );
}

function TailscaleSettings({ status, busy, change }: { status: ui.NetworkAccess; busy: boolean; change: Change }) {
  const ts = status.tailscale;

  return (
    <View style={{ gap: 24 }}>
      <SettingsGroup
        title="Tailscale"
        actions={<Button title="Check again" disabled={busy} onPress={() => void change("refresh_tailscale")} />}
      >
        <SettingsValue title="Status" value={ts?.state.replaceAll("_", " ") || "Unavailable"} />
        {ts?.dnsName ? <SettingsValue title="MagicDNS name" value={ts.dnsName} /> : null}
        {[...(ts?.ipv4 ?? []), ...(ts?.ipv6 ?? [])].map((address) => (
          <SettingsValue
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
            description={ts.https.unavailable || "Open the web interface using this computer's Tailscale address."}
            value={ts.https.enabled}
            disabled={busy || (!ts.https.enabled && !!ts.https.unavailable)}
            onChange={(enabled) => void change("set_tailscale_https", { enabled })}
          />
          {ts.https.error ? <Notice error>{ts.https.error}</Notice> : null}
          {ts.https.url ? <SettingsValue title="Address" value={ts.https.url} /> : null}
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
    </View>
  );
}
