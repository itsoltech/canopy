import { useState } from "react";
import type { connectors } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ConnectorForm } from "./ConnectorForm";
import { ConnectorAccess } from "./ConnectorAccess";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function ConnectorSettings() {
  const resource = useSettingsResource("ListConnectors", (api) => api.listConnectors({}));
  const [editing, setEditing] = useState<{ type: connectors.ConnectorType; account?: connectors.ConnectorAccount }>();
  const [tools, setTools] = useState<connectors.TestConnectorResponse>();

  return (
    <ResourceState resource={resource}>
      <Notice>
        Connect accounts and choose which workers and bots can use them. Credentials stay encrypted in the gateway.
      </Notice>
      <SettingsGroup title="Connectors">
        <SettingsSkeletonRows controls />
        {resource.data?.types.map((type) => (
          <SettingsRow
            key={type.id}
            title={type.name}
            description={type.requirements}
            control={<Button title="Add account" onPress={() => setEditing({ type })} />}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Accounts">
        <SettingsSkeletonRows controls />
        {resource.data?.accounts.map((account) => (
          <SettingsRow
            key={account.id}
            title={account.name}
            description={`${account.connectorType} · ${account.status} · This computer`}
          >
            <ConnectorError error={account.error} />
            <SettingsValue title="Endpoint" value={`${account.transport} · ${account.url}`} />
            <SettingsValue title="Secret headers" value={account.headerNames.join(", ")} />
            <SettingsInput
              title="Account name"
              value={account.name}
              busy={resource.busy}
              onSave={async (name) =>
                !!(await resource.run((api) =>
                  api.saveConnectorAccount({
                    id: account.id,
                    connectorType: account.connectorType,
                    url: account.url,
                    transport: account.transport,
                    authKind: account.authKind,
                    name,
                    expectedRevision: account.revision,
                  }),
                ))
              }
            />
            <Button
              title="Reconnect"
              onPress={() => {
                const type = resource.data?.types.find((t) => t.id === account.connectorType);

                if (type) setEditing({ type, account });
              }}
            />
            <Button
              title="Test connection"
              busy={resource.busy}
              onPress={() =>
                void resource
                  .run((api) => api.testConnector({ accountId: account.id }))
                  .then((r) => {
                    if (r) setTools(r);
                  })
              }
            />
            {tools?.account?.id === account.id && <ConnectorTools tools={tools} />}
            <ConnectorAccess account={account} onChanged={() => void resource.reload()} />
            <Button
              title="Disconnect account"
              disabled={resource.busy}
              onPress={() =>
                confirmAction(
                  "Disconnect account",
                  "This removes its credentials and stops access to its tools.",
                  () => void resource.run((api) => api.disconnectConnector({ accountId: account.id })),
                )
              }
            />
            <Button
              variant="danger"
              title="Delete account"
              disabled={resource.busy}
              onPress={() =>
                confirmAction(
                  "Delete account",
                  "This removes the account, its credentials and all access grants.",
                  () => void resource.run((api) => api.deleteConnectorAccount({ accountId: account.id })),
                )
              }
            />
          </SettingsRow>
        ))}
        {resource.data && !resource.data.accounts.length && (
          <SettingsRow title="No accounts yet" description="Add an account from the connector list." />
        )}
      </SettingsGroup>
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

function ConnectorError({ error }: { error?: connectors.ConnectorError }) {
  const [details, setDetails] = useState(false);

  if (!error) return null;

  return (
    <>
      <Notice error>{error.message}</Notice>
      <Button title={details ? "Hide details" : "Show details"} onPress={() => setDetails(!details)} />
      {details && <SettingsValue title="Connection details" value={error.detail} />}
    </>
  );
}

function ConnectorTools({ tools }: { tools: connectors.TestConnectorResponse }) {
  return (
    <SettingsGroup title="Tools">
      {tools.tools.map((tool) => (
        <SettingsValue key={tool.name} title={tool.name} value={tool.description} />
      ))}
      {!tools.tools.length && (
        <SettingsRow
          title="No tools available"
          description="Check the connection and account permissions, then test again."
        />
      )}
    </SettingsGroup>
  );
}
