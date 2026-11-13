import { useState } from "react";
import type { connectors } from "@canopy/contracts";
import { View } from "react-native";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ConnectorForm } from "./ConnectorForm";
import { ConnectorAccountRow } from "./ConnectorAccountRow";
import { ConnectorAccountDetails } from "./ConnectorAccountDetails";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { useForegroundInterval } from "../../ui/interval";

export function ConnectorSettings() {
  const resource = useSettingsResource("ListConnectors", (api) => api.listConnectors({}));
  const [editing, setEditing] = useState<{ type: connectors.ConnectorType; account?: connectors.ConnectorAccount }>();
  const [selected, setSelected] = useState<{ id: string; view: "actions" | "access" }>();
  const [now, setNow] = useState(Date.now);

  useForegroundInterval(() => setNow(Date.now()), 30_000);

  const account = resource.data?.accounts.find((entry) => entry.id === selected?.id);
  const type = resource.data?.types.find((entry) => entry.id === account?.connectorType);

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Add an account">
        <SettingsSkeletonRows controls />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {resource.data?.types.map((entry) => (
            <Button key={entry.id} size="sm" title={entry.name} onPress={() => setEditing({ type: entry })} />
          ))}
        </View>
      </SettingsGroup>
      <SettingsGroup title="Your accounts">
        <SettingsSkeletonRows controls />
        {resource.data?.accounts.map((entry) => (
          <ConnectorAccountRow
            key={entry.id}
            account={entry}
            now={now}
            provider={
              resource.data?.types.find((provider) => provider.id === entry.connectorType)?.name ?? entry.connectorType
            }
            onPress={() => setSelected({ id: entry.id, view: "access" })}
            onActions={() => setSelected({ id: entry.id, view: "actions" })}
          />
        ))}
        {resource.data && !resource.data.accounts.length && (
          <SettingsRow title="No accounts yet" description="Pick an app above to connect one." />
        )}
      </SettingsGroup>
      {account && type && selected && (
        <ConnectorAccountDetails
          key={account.id}
          account={account}
          type={type}
          initialView={selected.view}
          onClose={() => setSelected(undefined)}
          onChanged={resource.reload}
          onReconnect={() => {
            setSelected(undefined);
            setEditing({ type, account });
          }}
        />
      )}
      <Sheet
        title={editing?.account ? "Reconnect account" : "Add account"}
        visible={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ConnectorForm
            type={editing.type}
            account={editing.account}
            onSaved={() => {
              setEditing(undefined);
              void resource.reload();
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}
