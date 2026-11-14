import { Provider, type ui } from "@canopy/contracts";
import { Text, View } from "react-native";
import { Sensitive } from "../../ui/Sensitive";
import { styles, useColors } from "../../ui/theme";
import { useState } from "react";
import { providerName } from "../models/catalog";
import { Button, Notice } from "../../ui/components";
import { SettingsSection, SettingsActions } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { useOverview } from "../../state/overview";
import { ResourceState, useSettingsAction, workersFollowStream } from "./resource";
import { useDateTime } from "./display";
import { useForegroundInterval } from "../../ui/interval";
import { ProviderLoginActions } from "./ProviderLoginActions";

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
          // "expired": a turn's harness rejected the login, whatever the CLI reports.
          const rejected = account.state === "expired";
          const expired = rejected || (!!account.expiresAt && Number(account.expiresAt.seconds) * 1000 <= now);

          const state = rejected
            ? "Sign-in expired"
            : expired
              ? "Expired"
              : account.state === "signed_in"
                ? "Signed in"
                : account.state === "stored"
                  ? "Login saved"
                  : account.state === "signed_out"
                    ? "Not signed in"
                    : account.state === "error"
                      ? "Check failed"
                      : "";

          return (
            <View key={`${i.harness}/${i.id}`} style={{ gap: 12 }}>
              <SettingsValue
                title={`${providerName(i.harness)} · ${i.label || i.id}`}
                value={[state, account.authMethod, account.proxyName, account.plan, account.organization]
                  .filter(Boolean)
                  .join(" · ")}
                description={account.detail}
              />
              {account.email ? <PrivateValue title="Email" value={account.email} label="Account email" /> : null}
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
              <ProviderLoginActions
                workerId={worker.id}
                harness={i.harness}
                id={i.id}
                kind={i.kind}
                ownLogin={i.ownLogin}
                account={account}
                disabled={resource.busy || !!readOnly || !current.online}
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
      {account.configDir && (
        <PrivateValue title="Configuration directory" value={account.configDir} label="Configuration directory" />
      )}
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

/** A titled personal value, masked until tapped (web: Sensitive in WorkerAccounts). */
function PrivateValue({ title, value, label }: { title: string; value: string; label: string }) {
  const c = useColors();

  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.workMeta, { color: c.muted }]}>{title}</Text>
      <Sensitive value={value} label={label} style={[styles.chrome, { color: c.text }]} />
    </View>
  );
}
