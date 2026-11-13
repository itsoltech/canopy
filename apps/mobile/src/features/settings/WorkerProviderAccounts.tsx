import { Provider, type ui } from "@canopy/contracts";
import { View } from "react-native";
import { useState } from "react";
import { providerName } from "../models/catalog";
import { Button, Notice } from "../../ui/components";
import { SettingsSection, SettingsActions } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { useOverview } from "../../state/overview";
import { ResourceState, useSettingsAction, workersFollowStream } from "./resource";
import { useDateTime } from "./display";
import { useForegroundInterval } from "../../ui/interval";

export function WorkerProviderAccounts({ worker, readOnly }: { worker: ui.Worker; readOnly: string }) {
  // Workers follow the overview stream: their changes after an action arrive there, no read needed.
  const overview = useOverview();
  const resource = useSettingsAction(workersFollowStream);
  const current = overview.workers.find((w) => w.id === worker.id) ?? worker;
  const format = useDateTime();
  const [now, setNow] = useState(() => Date.now());

  useForegroundInterval(() => setNow(Date.now()), 60_000);

  const accounts = current.providerInstances.filter(
    (i) => i.enabled && i.account && (i.account.state !== "unknown" || i.account.authMethod || i.account.detail),
  );

  if (!accounts.length) return null;

  return (
    <SettingsSection title="Provider accounts">
      <ResourceState resource={resource} gap={12}>
        {accounts.map((i) => {
          const account = i.account;

          if (!account) return null;
          const expired = !!account.expiresAt && Number(account.expiresAt.seconds) * 1000 <= now;

          const state = expired
            ? "Expired"
            : account.state === "signed_in"
              ? "Signed in"
              : account.state === "signed_out"
                ? "Not signed in"
                : account.state === "error"
                  ? "Check failed"
                  : "";

          return (
            <View key={`${i.harness}/${i.id}`} style={{ gap: 12 }}>
              <SettingsValue
                title={`${providerName(i.harness)} · ${i.label || i.id}`}
                value={[state, account.authMethod, account.proxyName, account.plan, account.organization, account.email]
                  .filter(Boolean)
                  .join(" · ")}
                description={account.detail}
              />
              <AccountActions
                worker={current}
                instance={i}
                expired={expired}
                disabled={resource.busy || !!readOnly || !current.online}
                refresh={() =>
                  void resource.run((api) =>
                    api.refreshProviders({ workerId: worker.id, harness: i.harness, id: i.id, accountOnly: true }),
                  )
                }
                format={format}
              />
            </View>
          );
        })}
      </ResourceState>
    </SettingsSection>
  );
}

function AccountActions({
  worker,
  instance,
  disabled,
  refresh,
  format,
  expired,
}: {
  worker: ui.Worker;
  instance: ui.WorkerInstance;
  disabled: boolean;
  refresh: () => void;
  format: ReturnType<typeof useDateTime>;
  expired: boolean;
}) {
  const account = instance.account;

  if (!account) return null;
  const signIn = account.authMethod !== "Proxy" && (expired || account.state === "signed_out");

  const command =
    instance.harness === Provider.CLAUDE
      ? "claude auth login"
      : instance.harness === Provider.CODEX
        ? "codex login"
        : "grok login";

  return (
    <>
      {account.expiresAt && <SettingsValue title="Expires" value={format(account.expiresAt.seconds)} />}
      {account.checkedAt && <SettingsValue title="Last checked" value={format(account.checkedAt.seconds)} />}
      {account.configDir && <SettingsValue title="Configuration directory" value={account.configDir} />}
      {instance.harness !== Provider.GROK && (
        <SettingsActions>
          <Button title={`Refresh ${instance.label || instance.id} account`} disabled={disabled} onPress={refresh} />
        </SettingsActions>
      )}
      {signIn && (
        <Notice>
          Run {command} on {worker.name}, then refresh.
        </Notice>
      )}
    </>
  );
}
