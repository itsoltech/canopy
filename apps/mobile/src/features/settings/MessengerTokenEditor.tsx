import { useState } from "react";
import type { ui } from "@canopy/contracts";
import * as Linking from "expo-linking";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsActions } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { messengerSetupFailure, tokenMessengers, type TokenMessenger } from "./messenger-accounts";

/** Connects a Telegram or Discord bot by its token, or renames it and replaces the token. */
export function MessengerTokenEditor({
  provider,
  account,
  onClose,
  onSaved,
}: {
  provider: TokenMessenger;
  account?: ui.MessengerAccount;
  onClose: () => void;
  onSaved: (account: ui.MessengerAccount) => void;
}) {
  const copy = tokenMessengers[provider];

  const resource = useSettingsResource(
    "ListMessengerAccounts",
    (api) => api.listMessengerAccounts({}),
    true,
    messengerSetupFailure,
  );

  const [name, setName] = useState(account?.name ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const title = account ? `Edit ${copy.bot}` : `Connect ${copy.bot}`;
  const { busy } = resource;

  async function save() {
    setError("");

    const result = await resource.run((api) =>
      api.saveMessengerAccount({
        id: account?.id,
        name: name.trim(),
        provider: account ? undefined : provider,
        botToken: token.trim() || undefined,
      }),
    );

    if (result?.account) onSaved(result.account);
  }

  return (
    <Sheet title={title} visible onClose={() => !busy && onClose()}>
      <ResourceState resource={resource}>
        <SettingsDisclosure title={`Set up the ${copy.app} bot`} initiallyOpen={!account}>
          <Notice>{copy.setup.join(" ")}</Notice>
          <SettingsActions>
            <Button
              title={copy.setupTitle}
              onPress={() =>
                void Linking.openURL(copy.setupUrl).catch(() =>
                  setError(`Could not open ${copy.app}. Check your browser and try again.`),
                )
              }
            />
          </SettingsActions>
        </SettingsDisclosure>
        {account && <Notice>Leave the token blank to keep its saved value.</Notice>}
        <Field label="Account name" value={name} maxLength={120} editable={!busy} onChangeText={setName} />
        <Field
          label="Bot token"
          value={token}
          editable={!busy}
          onChangeText={setToken}
          placeholder={copy.placeholder}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!(error || resource.inlineError) && <Notice error>{error || resource.inlineError}</Notice>}
        <Button
          title={account ? "Save changes" : title}
          variant="primary"
          busy={busy}
          disabled={!name.trim() || (!account && !token.trim())}
          onPress={() => void save()}
        />
      </ResourceState>
    </Sheet>
  );
}
