import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { confirmAction, ResourceState, useSettingsResource } from "./resource";
import { MessengerTokenEditor } from "./MessengerTokenEditor";
import { disconnectDescription, messengerStatus, tokenMessengers, type TokenMessenger } from "./messenger-accounts";

/** Telegram or Discord bots connected by token. SlackBotSettings, shown beside them, polls the shared account list. */
export function MessengerTokenBots({ provider }: { provider: TokenMessenger }) {
  const copy = tokenMessengers[provider];
  const resource = useSettingsResource("ListMessengerAccounts", (api) => api.listMessengerAccounts({}));
  const [editing, setEditing] = useState<ui.MessengerAccount | "new">();
  const [selectedId, select] = useState("");
  const accounts = resource.data?.accounts.filter((entry) => entry.provider === provider);
  const selected = accounts?.find((entry) => entry.id === selectedId);

  function edit(account: ui.MessengerAccount | "new") {
    select("");
    setEditing(account);
  }

  return (
    // The shared account list reports load failures once, in the Slack Bot section above.
    <ResourceState resource={{ ...resource, error: "", message: "" }}>
      <SettingsGroup
        title={copy.title}
        description={copy.description}
        actions={
          <Button title={`Connect ${copy.bot}`} size="sm" disabled={!resource.data} onPress={() => edit("new")} />
        }
      >
        {accounts?.map((account) => (
          <SettingsRow
            key={account.id}
            title={account.name}
            description={messengerStatus(account)}
            onPress={() => select(account.id)}
          />
        ))}
        {accounts && !accounts.length && <SettingsRow title={`No ${copy.title} connected`} />}
      </SettingsGroup>
      <Sheet title={selected?.name ?? copy.bot} visible={!!selected} onClose={() => select("")}>
        {selected && (
          <MessengerTokenBotActions
            account={selected}
            provider={provider}
            resource={resource}
            onEdit={() => edit(selected)}
            onDeleted={() => select("")}
          />
        )}
      </Sheet>
      {editing && (
        <MessengerTokenEditor
          key={editing === "new" ? "new" : editing.id}
          provider={provider}
          account={editing === "new" ? undefined : editing}
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

function MessengerTokenBotActions({
  account,
  provider,
  resource,
  onEdit,
  onDeleted,
}: {
  account: ui.MessengerAccount;
  provider: TokenMessenger;
  resource: ReturnType<typeof useSettingsResource<ui.ListMessengerAccountsResponse>>;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { busy } = resource;
  const disconnect = `Disconnect ${tokenMessengers[provider].bot}`;

  return (
    <>
      {account.enabled && account.status === "needs_reconnect" && (
        <Notice>To reconnect, edit the account and paste the bot token again.</Notice>
      )}
      {resource.error && <Notice error>{resource.error}</Notice>}
      <SettingsActions>
        <Button title="Edit account" disabled={busy} onPress={onEdit} />
        <Button
          title={account.enabled ? "Pause messages" : "Resume messages"}
          disabled={busy}
          onPress={() =>
            void resource.run((api) =>
              api.saveMessengerAccount({ id: account.id, name: account.name, enabled: !account.enabled }),
            )
          }
        />
        <Button
          title={disconnect}
          variant="danger"
          disabled={busy}
          onPress={() =>
            confirmAction(
              disconnect,
              disconnectDescription,
              () =>
                void resource
                  .run((api) => api.deleteMessengerAccount({ accountId: account.id }))
                  .then((deleted) => {
                    if (deleted) onDeleted();
                  }),
            )
          }
        />
      </SettingsActions>
    </>
  );
}
