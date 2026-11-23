import { useState } from "react";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import type { connectors, ui } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { ConnectorSignInReturn } from "./ConnectorSignInReturn";
import { ResourceState, useSettingsAction } from "./resource";

export function SlackBotAuthorization({
  account,
  user,
  onChanged,
}: {
  account: ui.MessengerAccount;
  user: connectors.ConnectorAccount;
  onChanged: () => Promise<void>;
}) {
  const resource = useSettingsAction({ reload: onChanged, error: "" });
  const [binding] = useState(() => Crypto.randomUUID());
  const [waiting, setWaiting] = useState(false);

  async function begin() {
    await resource.run(async (api) => {
      const result = await api.beginConnectorOAuth(
        { accountId: user.id, browserBinding: binding, slackMessaging: true },
        { timeoutMs: 60_000 },
      );

      const url = new URL(result.authorizationUrl);

      if (url.protocol !== "https:") throw new Error("Invalid sign-in address");
      await Linking.openURL(url.href);
      setWaiting(true);
    });
  }

  return (
    <ResourceState resource={resource}>
      <Notice>This bot uses the Slack app registered for {user.name} in Slack User.</Notice>
      <Button
        title={account.status === "needs_authorization" ? "Authorize Slack Bot" : "Reconnect Slack Bot"}
        busy={resource.busy}
        onPress={() => void begin()}
      />
      {waiting && (
        <ConnectorSignInReturn
          binding={binding}
          accountId={user.id}
          slackMessaging
          onComplete={() => {
            setWaiting(false);
            void onChanged();
          }}
        />
      )}
    </ResourceState>
  );
}
