import { useState } from "react";
import type { connectors, ui } from "@canopy/contracts";
import * as Linking from "expo-linking";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { copyText } from "../viewers/useCopyText";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsActions, SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function SlackBotEditor({
  account,
  catalog,
  linked,
  users,
  onClose,
  onSaved,
}: {
  account?: ui.MessengerAccount;
  catalog: ui.ListMessengerAccountsResponse;
  linked?: connectors.ConnectorAccount;
  users: connectors.ConnectorAccount[];
  onClose: () => void;
  onSaved: (account: ui.MessengerAccount) => void;
}) {
  const resource = useSettingsResource("ListMessengerAccounts", (api) => api.listMessengerAccounts({}));
  const [name, setName] = useState(account?.name ?? "");
  const [userId, setUser] = useState(linked?.id ?? "");
  const [app, setApp] = useState("");
  const [bot, setBot] = useState("");
  const [error, setError] = useState("");
  const relink = !!account?.requiresSlackUser && !linked;
  const shared = !!userId || relink;
  const manifest = shared ? catalog.slackAppManifest : catalog.slackBotAppManifest;
  const title = relink ? "Link Slack User" : account ? "Edit Slack Bot" : "Connect Slack Bot";
  const { busy } = resource;

  async function save() {
    if (!relink && (!account || app.trim()) && !/^xapp-\S+$/.test(app.trim())) {
      setError("Enter an app-level token starting with xapp-.");

      return;
    }

    if (!shared && (!account || bot.trim()) && !/^xoxb-\S+$/.test(bot.trim())) {
      setError("Enter a bot token starting with xoxb-.");

      return;
    }

    setError("");

    const result = await resource.run((api) =>
      api.saveMessengerAccount({
        id: account?.id,
        name: name.trim(),
        connectorAccountId: userId,
        appToken: app.trim() || undefined,
        botToken: shared ? undefined : bot.trim() || undefined,
      }),
    );

    if (result?.account) onSaved(result.account);
  }

  return (
    <Sheet title={title} visible onClose={() => !busy && onClose()}>
      <ResourceState resource={resource}>
        {(!account && users.length > 0 && !!catalog.slackAppManifest) || relink ? (
          <SettingChoice
            title={relink ? "Slack User account" : "Slack app"}
            value={userId}
            disabled={busy}
            onChange={(id) => {
              setUser(id);
              setApp("");
              setBot("");
              setError("");
            }}
            options={[
              { value: "", label: relink ? "Choose an account" : "Use a separate Slack app" },
              ...users.map((user) => ({ value: user.id, label: `Use Slack User · ${user.name}` })),
            ]}
          />
        ) : null}
        {(!account || shared) && (
          <SlackBotAppSetup
            shared={shared}
            manifest={manifest}
            createUrl={catalog.slackBotAppCreateUrl}
            initiallyOpen={!account}
            setError={setError}
          />
        )}
        {!relink && (
          <>
            {account && <Notice>Leave token fields blank to keep their saved values.</Notice>}
            <Field label="Account name" value={name} maxLength={120} editable={!busy} onChangeText={setName} />
            <Field
              label="App-level token"
              value={app}
              editable={!busy}
              onChangeText={setApp}
              placeholder="xapp-…"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            {!shared && (
              <Field
                label="Bot token"
                value={bot}
                editable={!busy}
                onChangeText={setBot}
                placeholder="xoxb-…"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          </>
        )}
        {!!error && <Notice error>{error}</Notice>}
        <Button
          title={relink ? "Link Slack User" : account ? "Save changes" : shared ? "Save token" : title}
          variant="primary"
          busy={busy}
          disabled={!name.trim() || (relink && !userId)}
          onPress={() => void save()}
        />
      </ResourceState>
    </Sheet>
  );
}

function SlackBotAppSetup({
  shared,
  manifest,
  createUrl,
  initiallyOpen,
  setError,
}: {
  shared: boolean;
  manifest: string;
  createUrl: string;
  initiallyOpen: boolean;
  setError: (message: string) => void;
}) {
  return (
    <SettingsDisclosure title={shared ? "Update the Slack app" : "Set up the Slack app"} initiallyOpen={initiallyOpen}>
      <Notice>
        {shared
          ? "Add the manifest’s bot scopes, events, Socket Mode, and App Home settings to the Slack app. Enable PKCE and reinstall the app in your workspace."
          : "Create the Slack app, keep bot token rotation off, and install it in your workspace."}{" "}
        Generate an app-level token with connections:write in Basic Information.
      </Notice>
      <SettingsActions>
        <Button
          title={shared ? "Open Slack apps" : "Create Slack app"}
          onPress={() =>
            void Linking.openURL((!shared && createUrl) || "https://api.slack.com/apps").catch(() =>
              setError("Could not open Slack. Check your browser and try again."),
            )
          }
        />
        {!!manifest && <Button title="Copy manifest" onPress={() => void copyText(manifest)} />}
      </SettingsActions>
    </SettingsDisclosure>
  );
}
