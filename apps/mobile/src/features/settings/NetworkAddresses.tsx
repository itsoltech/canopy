import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { copyText } from "../viewers/useCopyText";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

const kinds = new Map(
  Object.entries({
    lan: "Local network",
    tailscale: "Tailscale",
    vpn: "VPN",
    public: "Public",
    hostname: "Added by you",
  }),
);

export function NetworkAddresses({
  status,
  linked,
  busy,
  save,
}: {
  status: ui.NetworkAccess;
  linked: boolean;
  busy: boolean;
  save: (hostnames: string[]) => Promise<boolean>;
}) {
  const [hostname, setHostname] = useState<string>();
  const [failed, setFailed] = useState(false);

  const other = status.hostnames.filter(
    (name) => !status.addresses.some((a) => a.kind === "hostname" && a.host === name),
  );

  const remove = (name: string) => (
    <IconButton
      icon="trash"
      size="sm"
      label={`Remove ${name}`}
      disabled={busy}
      onPress={() => void save(status.hostnames.filter((entry) => entry !== name))}
    />
  );

  function savedStatus(name: string) {
    if (status.state !== "on") return "Added by you";
    const authority = /:\d+$/.test(name) ? name : `${name}:${status.port}`;

    return status.addresses.some((a) => a.origin === `https://${authority}`)
      ? "Matches a listed address"
      : "Excluded by allowed networks";
  }

  return (
    <>
      <SettingsGroup
        title="Reachable at"
        description={
          linked
            ? "Phones and linked computers try these addresses in turn. They follow this computer from network to network."
            : "Paired devices and workers try these addresses in turn to reach this gateway."
        }
        actions={
          <Button
            size="sm"
            title="Add hostname"
            disabled={busy}
            onPress={() => {
              setFailed(false);
              setHostname("");
            }}
          />
        }
      >
        {status.addresses.map((address) => (
          <SettingsRow
            key={address.origin}
            title={address.origin}
            description={[kinds.get(address.kind) ?? address.kind, address.interfaceName].filter(Boolean).join(" · ")}
            inlineControl
            control={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <IconButton
                  size="sm"
                  label={`Copy ${address.origin}`}
                  icon="clipboard-document"
                  onPress={() => void copyText(address.origin)}
                />
                {address.kind === "hostname" && remove(address.host)}
              </View>
            }
          />
        ))}
        {!status.addresses.length && (
          <SettingsRow
            title={status.state === "on" ? "No reachable addresses" : "Not reachable"}
            description={
              status.note ||
              (status.state === "off"
                ? "Turn on network access to see this computer’s addresses."
                : "Check this computer’s network connection.")
            }
          />
        )}
      </SettingsGroup>
      {!!other.length && (
        <SettingsGroup title="Saved hostnames">
          {other.map((name) => (
            <SettingsRow key={name} title={name} description={savedStatus(name)} inlineControl control={remove(name)} />
          ))}
        </SettingsGroup>
      )}
      <Sheet visible={hostname !== undefined} title="Add hostname" onClose={() => !busy && setHostname(undefined)}>
        <Field
          label="Hostname"
          value={hostname ?? ""}
          onChangeText={setHostname}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="laptop.tailnet.ts.net"
        />
        <Notice>Add a port only when a router or firewall forwards another port to this computer.</Notice>
        {failed && <Notice error>Could not add this hostname. Check the address and try again.</Notice>}
        <Button
          title="Add hostname"
          variant="primary"
          disabled={!hostname?.trim()}
          busy={busy}
          onPress={() => {
            if (hostname?.trim())
              void save([...status.hostnames, hostname.trim()]).then((saved) => {
                if (saved) setHostname(undefined);
                else setFailed(true);
              });
          }}
        />
      </Sheet>
    </>
  );
}
