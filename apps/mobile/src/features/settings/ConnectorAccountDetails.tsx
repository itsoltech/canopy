import { useState } from "react";
import type { connectors } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { connectorStatus } from "@canopy/domain/format";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsAction } from "./resource";
import { useDevicePreferences } from "./device-preferences";
import { ConnectorAccess } from "./ConnectorAccess";

export function ConnectorAccountDetails({
  account,
  type,
  initialView,
  onClose,
  onChanged,
  onReconnect,
}: {
  account: connectors.ConnectorAccount;
  type: connectors.ConnectorType;
  initialView: "actions" | "access";
  onClose: () => void;
  onChanged: () => Promise<void>;
  onReconnect: () => void;
}) {
  const resource = useSettingsAction({ reload: onChanged, error: "" });
  const [view, setView] = useState<"actions" | "access" | "rename">(initialView);
  const [tools, setTools] = useState<connectors.TestConnectorResponse>();
  const { values } = useDevicePreferences();

  const lastUsed = account.lastUsedAt
    ? timestampDate(account.lastUsedAt).toLocaleString("en", {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: values.timeFormat === "system" ? undefined : values.timeFormat === "12h",
      })
    : "Not used yet";

  return (
    <Sheet
      title={view === "rename" ? "Rename account" : account.name}
      visible
      onClose={() => {
        if (!resource.busy) onClose();
      }}
    >
      <ResourceState resource={resource}>
        {view === "rename" ? (
          <ConnectorRename
            account={account}
            busy={resource.busy}
            onCancel={() => setView("actions")}
            onSave={(name) =>
              void resource
                .run((api) => api.saveConnectorAccount({ id: account.id, name, expectedRevision: account.revision }))
                .then((result) => {
                  if (result) setView("actions");
                })
            }
          />
        ) : (
          <>
            <SettingsValue title={type.name} value={`${connectorStatus(account.status)} · This computer`} />
            <SettingsValue title="Last used" value={lastUsed} />
            {view === "actions" ? (
              <ConnectorActions
                account={account}
                resource={resource}
                onReconnect={onReconnect}
                onRename={() => setView("rename")}
                onAccess={() => setView("access")}
                onTools={setTools}
                onClose={onClose}
              />
            ) : (
              <>
                <ConnectorAccess account={account} onChanged={() => void onChanged()} />
                <SettingsValue title="Endpoint" value={`${account.transport} · ${account.url}`} />
                {!!account.headerNames.length && (
                  <SettingsValue title="Secret headers" value={account.headerNames.join(", ")} />
                )}
                <Button title="Show actions" onPress={() => setView("actions")} />
              </>
            )}
            <ConnectorFeedback error={account.error} tools={account.status === "connected" ? tools : undefined} />
          </>
        )}
      </ResourceState>
    </Sheet>
  );
}

function ConnectorActions({
  account,
  resource,
  onReconnect,
  onRename,
  onAccess,
  onTools,
  onClose,
}: {
  account: connectors.ConnectorAccount;
  resource: ReturnType<typeof useSettingsAction>;
  onReconnect: () => void;
  onRename: () => void;
  onAccess: () => void;
  onTools: (tools: connectors.TestConnectorResponse | undefined) => void;
  onClose: () => void;
}) {
  const [testing, setTesting] = useState(false);

  function test() {
    setTesting(true);
    onTools(undefined);
    void resource
      .run((api) => api.testConnector({ accountId: account.id }))
      .then(onTools)
      .finally(() => setTesting(false));
  }

  return (
    <SettingsGroup>
      <Button
        title={testing ? "Testing…" : "Test"}
        variant="ghost"
        busy={testing}
        disabled={resource.busy || account.status === "disconnected" || account.status === "needs_reconnect"}
        onPress={test}
      />
      <Button title="Reconnect" variant="ghost" disabled={resource.busy} onPress={onReconnect} />
      <Button title="Rename…" variant="ghost" disabled={resource.busy} onPress={onRename} />
      <Button title="Edit access" variant="ghost" disabled={resource.busy} onPress={onAccess} />
      <Button
        title="Disconnect"
        variant="ghost"
        disabled={resource.busy || account.status === "disconnected"}
        onPress={() =>
          confirmAction(
            "Disconnect account",
            "Computers sharing configuration lose access to this account. You can reconnect it later.",
            () => void resource.run((api) => api.disconnectConnector({ accountId: account.id })),
          )
        }
      />
      <Button
        title="Delete…"
        variant="danger"
        disabled={resource.busy}
        onPress={() =>
          confirmAction(
            "Delete account",
            "This removes the account from computers sharing configuration. Workers and bots lose access. A linked computer can restore it for 90 days.",
            () =>
              void resource
                .run((api) => api.deleteConnectorAccount({ accountId: account.id }))
                .then((result) => {
                  if (result) onClose();
                }),
          )
        }
      />
    </SettingsGroup>
  );
}

function ConnectorRename({
  account,
  busy,
  onSave,
  onCancel,
}: {
  account: connectors.ConnectorAccount;
  busy: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(account.name);

  return (
    <>
      <Field label="Account name" value={name} onChangeText={setName} maxLength={80} editable={!busy} />
      <Button
        title="Rename"
        variant="primary"
        busy={busy}
        disabled={!name.trim() || name === account.name}
        onPress={() => onSave(name)}
      />
      <Button title="Cancel" disabled={busy} onPress={onCancel} />
    </>
  );
}

function ConnectorFeedback({
  error,
  tools,
}: {
  error?: connectors.ConnectorError;
  tools?: connectors.TestConnectorResponse;
}) {
  const [details, setDetails] = useState(false);

  return (
    <>
      {error ? (
        <>
          <Notice error>{error.message}</Notice>
          {!!error.detail && (
            <Button title={details ? "Hide details" : "Show details"} onPress={() => setDetails(!details)} />
          )}
          {details && <SettingsValue title="Connection details" value={error.detail} />}
        </>
      ) : (
        tools && (
          <>
            <Notice>
              Connection verified · {tools.tools.length} {tools.tools.length === 1 ? "tool" : "tools"}
            </Notice>
            <Button title={details ? "Hide tools" : "Show tools"} onPress={() => setDetails(!details)} />
            {details &&
              tools.tools.map((tool) => (
                <SettingsValue key={tool.name} title={tool.remoteName} value={tool.description} />
              ))}
          </>
        )
      )}
    </>
  );
}
