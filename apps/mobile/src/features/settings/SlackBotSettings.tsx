import { useState } from "react";
import type { connectors, ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { useForegroundInterval } from "../../ui/interval";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { confirmAction, ResourceState, useSettingsResource } from "./resource";
import { SlackBotEditor } from "./SlackBotEditor";
import { SlackBotAuthorization } from "./SlackBotAuthorization";

const statuses = new Map(
  Object.entries({
    connected: "Connected",
    connecting: "Connecting…",
    retrying: "Reconnecting…",
    needs_authorization: "Authorization needed",
    needs_reconnect: "Reconnect needed",
    error: "Connection error",
    disconnected: "Disconnected",
  }),
);

export function SlackBotSettings({ users }: { users: connectors.ConnectorAccount[] }) {
  const resource = useSettingsResource("ListMessengerAccounts", (api) => api.listMessengerAccounts({}));
  const [editing, setEditing] = useState<ui.MessengerAccount | "new">();
  const [selectedId, select] = useState("");
  const { data, busy } = resource;
  useForegroundInterval(() => void resource.reload(), 30_000, !busy);
  const selected = data?.accounts.find((entry) => entry.id === selectedId);
  const linked = users.find((entry) => !!selected && entry.id === selected.connectorAccountId);
  const orphaned = !!selected?.requiresSlackUser && !linked;
  const unavailable = linked && ["disconnected", "needs_reconnect"].includes(linked.status);

  const available = users.filter(
    (user) =>
      ["connected", "error"].includes(user.status) &&
      !data?.accounts.some((entry) => entry.connectorAccountId === user.id),
  );

  function edit(account: ui.MessengerAccount | "new") {
    select("");
    setEditing(account);
  }

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Slack Bot accounts"
        description="Receive and reply to Slack messages as your Slack app’s bot."
        actions={<Button title="Connect Slack Bot" size="sm" disabled={!data} onPress={() => edit("new")} />}
      >
        {data?.accounts.map((account) => (
          <SettingsRow
            key={account.id}
            title={account.name}
            description={!account.enabled ? "Paused" : (statuses.get(account.status) ?? "Waiting for connection")}
            onPress={() => select(account.id)}
          />
        ))}
        {data && !data.accounts.length && <SettingsRow title="No Slack Bot accounts connected" />}
      </SettingsGroup>
      <Sheet title={selected?.name ?? "Slack Bot"} visible={!!selected} onClose={() => select("")}>
        {selected && (
          <>
            {orphaned && (
              <Notice>
                Link a Slack User account from the same app and workspace to restore these message routes.
              </Notice>
            )}
            {unavailable && (
              <Notice>Reconnect {linked.name} under Tool accounts, then authorize Slack Bot again.</Notice>
            )}
            {linked && !unavailable && (
              <SlackBotAuthorization key={selected.id} account={selected} user={linked} onChanged={resource.reload} />
            )}
            {resource.error && <Notice error>{resource.error}</Notice>}
            <SettingsActions>
              <Button
                title={orphaned ? "Link Slack User" : "Edit account"}
                disabled={busy || (orphaned && !available.length)}
                onPress={() => edit(selected)}
              />
              {(!orphaned || selected.enabled) && (
                <Button
                  title={selected.enabled ? "Pause messages" : "Resume messages"}
                  disabled={busy || (!selected.enabled && (!!unavailable || selected.status === "needs_authorization"))}
                  onPress={() =>
                    void resource.run((api) =>
                      api.saveMessengerAccount({ id: selected.id, name: selected.name, enabled: !selected.enabled }),
                    )
                  }
                />
              )}
              <Button
                title="Disconnect Slack Bot"
                variant="danger"
                disabled={busy}
                onPress={() =>
                  confirmAction(
                    "Disconnect Slack Bot",
                    "This removes every message route using this account. To receive messages again, reconnect the bot and add its routes.",
                    () =>
                      void resource
                        .run((api) => api.deleteMessengerAccount({ accountId: selected.id }))
                        .then((saved) => {
                          if (saved) select("");
                        }),
                  )
                }
              />
            </SettingsActions>
          </>
        )}
      </Sheet>
      {editing && data && (
        <SlackBotEditor
          key={editing === "new" ? "new" : editing.id}
          account={editing === "new" ? undefined : editing}
          catalog={data}
          users={available}
          linked={editing === "new" ? undefined : users.find((user) => user.id === editing.connectorAccountId)}
          onClose={() => setEditing(undefined)}
          onSaved={(account) => {
            setEditing(undefined);
            select(account.id);
          }}
        />
      )}
    </ResourceState>
  );
}
