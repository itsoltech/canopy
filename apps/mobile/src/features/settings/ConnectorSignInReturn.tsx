import { useState } from "react";
import { Button, Field, Notice } from "../../ui/components";
import type { connectors } from "@canopy/contracts";
import { ResourceState, useSettingsAction } from "./resource";

export function ConnectorSignInReturn({
  accountId,
  binding,
  slackMessaging = false,
  onComplete,
}: {
  accountId: string;
  binding: string;
  slackMessaging?: boolean;
  onComplete: (result: connectors.CompleteConnectorOAuthResponse) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const action = useSettingsAction({ error: "", reload: async () => {} });

  async function complete() {
    setError("");

    const result = await action.run((api) =>
      api.completeConnectorOAuth({ browserBinding: binding, pastedCode: code.trim() }),
    );

    if (!result) return;

    if (result.account?.id !== accountId || result.error || result.slackMessaging !== slackMessaging) {
      setError(result.error || "This sign-in did not finish. Start sign-in again.");

      return;
    }

    setCode("");
    onComplete(result);
  }

  return (
    <ResourceState resource={action}>
      <Notice>Finish sign-in in your browser, then paste the return code or URL here.</Notice>
      <Field
        label="Return code or URL"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={code}
        onChangeText={setCode}
      />
      {!!error && <Notice error>{error}</Notice>}
      <Button title="Complete sign-in" disabled={!code.trim()} busy={action.busy} onPress={() => void complete()} />
    </ResourceState>
  );
}
