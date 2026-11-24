import { providerLoginCommand } from "@canopy/domain/provider-accounts";
import { StyleSheet, Text, View } from "react-native";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { hasAccountStatus, kindLabel, statusOn } from "@canopy/domain/provider-instances";
import { styles, useColors } from "../../ui/theme";
import { ProviderLoginActions } from "../settings/ProviderLoginActions";
import { copyText } from "../viewers/useCopyText";
import { IconButton } from "../../ui/components";
import { SettingsSection, SettingsRow } from "../settings/SettingsGroup";
import { SettingsValue } from "../settings/SettingsValue";
import { ProviderAccountRow } from "./ProviderAccountRow";
import { StatusLine } from "./InstanceRow";
import { ProxyThrough } from "./ProxyThrough";
import { UsageMeters } from "./UsageMeters";

/** One worker's view of the instance (web: InstanceDetail's status list): status, account, plan meters, sign-in. */
function OnWorker({
  instance,
  worker,
  on,
  now,
}: {
  instance: ui.ProviderInstance;
  worker: ui.Worker;
  on: ui.InstanceOnWorker | undefined;
  now: number;
}) {
  const accountShown = !!on?.enabled && hasAccountStatus(on.account, instance.harness);
  const appSignIn = instance.kind === ProviderProfileKind.NATIVE && instance.harness !== Provider.ANTIGRAVITY;

  return (
    <View style={{ gap: 10 }}>
      <SettingsValue title={`On ${worker.name}`} value={statusOn(on, worker.online).label} />
      {instance.harness === Provider.ANTIGRAVITY &&
        on?.enabled &&
        !!on.version &&
        (on.account?.state === "expired" ||
          on.account?.state === "signed_out" ||
          (!on.authenticated && !on.account?.authMethod)) && (
          <SettingsValue
            title="Sign in on the worker"
            value={providerLoginCommand("antigravity", on.account, worker.os)}
          />
        )}
      {on?.version ? <SettingsValue title="Version" value={on.version} /> : null}
      {on?.reported && on.account?.authMethod !== "Proxy" ? (
        <SettingsValue title="Connection" value={kindLabel(on.kind)} />
      ) : null}
      {on?.reported && !on.available && on.detail ? <SettingsValue title="Detail" value={on.detail} /> : null}
      {on?.checkedAt && !accountShown ? (
        <SettingsValue
          title="Checked"
          value={`${formatRelative(on.checkedAt, now)}${on.synced ? "" : " · newer settings on their way"}`}
        />
      ) : on?.reported && !on.synced ? (
        <SettingsValue title="Settings" value="Newer settings on their way" />
      ) : null}
      {on && accountShown ? (
        <ProviderAccountRow
          account={on.account}
          workerId={worker.id}
          harness={instance.harness}
          id={instance.id}
          online={worker.online}
          now={now}
        />
      ) : null}
      <UsageMeters usage={on?.usage} now={now} />
      {instance.harness === Provider.CLAUDE && on?.reported && <ReportedPaths status={on} />}
      {appSignIn && on?.enabled ? (
        <ProviderLoginActions
          key={`${worker.id}/${instance.harness}/${instance.id}`}
          workerId={worker.id}
          harness={instance.harness}
          id={instance.id}
          kind={instance.kind}
          ownLogin={instance.runtime?.ownLogin ?? false}
          account={on.account}
        />
      ) : null}
    </View>
  );
}

function ReportedPaths({ status }: { status: ui.InstanceOnWorker }) {
  const paths = [
    { label: "Login source", value: status.loginHomePath },
    { label: "Configuration source", value: status.configurationHomePath },
    { label: "Thread history", value: status.sessionHomePath },
    { label: "Private state", value: status.privateHomePath },
  ].filter((path) => path.value);

  if (!paths.length) return null;

  return (
    <SettingsSection title="Reported paths" description="Existing threads may keep their previous history directory.">
      {paths.map(({ label, value }) => (
        <SettingsRow
          key={label}
          title={label}
          description={value}
          control={
            <IconButton
              icon="clipboard-document"
              label={`Copy ${label.toLowerCase()}`}
              onPress={() => void copyText(value)}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

/** The status on every worker that runs or once ran the instance ("All workers"). */
function AcrossWorkers({
  instance,
  workers,
  now,
}: {
  instance: ui.ProviderInstance;
  workers: readonly ui.Worker[];
  now: number;
}) {
  const c = useColors();
  const workerOf = (id: string) => workers.find((w) => w.id === id);

  if (!instance.workers.length) return <Text style={[styles.chrome, { color: c.muted }]}>No workers yet.</Text>;

  return (
    <View
      accessibilityLabel="Status on each worker"
      style={{ borderWidth: 1, borderColor: c.ring, borderRadius: 10, overflow: "hidden" }}
    >
      {instance.workers.map((w, index) => {
        const worker = workerOf(w.workerId);
        const online = worker?.online ?? false;

        return (
          <View
            key={w.workerId}
            style={{
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
              borderColor: c.ring,
            }}
          >
            <View style={[styles.row, { minWidth: 0 }]}>
              <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: c.text }]}>
                {worker?.name ?? w.workerId.slice(-8)}
              </Text>
              {w.version ? (
                <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>v{w.version}</Text>
              ) : null}
            </View>
            <StatusLine status={statusOn(w, online)} />
            {w.reported && w.account?.authMethod !== "Proxy" ? (
              <Text style={[styles.workMeta, { color: c.muted }]}>
                {kindLabel(w.kind)}
                {hasAccountStatus(w.account, instance.harness)
                  ? ""
                  : ` · ${w.checkedAt ? `Checked ${formatRelative(w.checkedAt, now)}` : "Check time unknown"}`}
              </Text>
            ) : null}
            {w.enabled && hasAccountStatus(w.account, instance.harness) ? (
              <ProviderAccountRow
                account={w.account}
                workerId={w.workerId}
                harness={instance.harness}
                id={instance.id}
                online={online}
                now={now}
              />
            ) : null}
            <UsageMeters usage={w.usage} now={now} />
          </View>
        );
      })}
    </View>
  );
}

/** The Status section of an instance (web: InstanceDetail → Status). */
export function InstanceStatus({
  instance,
  worker,
  workers,
  now,
}: {
  instance: ui.ProviderInstance;
  worker: ui.Worker | undefined;
  workers: readonly ui.Worker[];
  now: number;
}) {
  return (
    <View style={{ gap: 12 }}>
      {instance.proxyId ? <ProxyThrough instance={instance} /> : null}
      {worker ? (
        <OnWorker
          instance={instance}
          worker={worker}
          on={instance.workers.find((w) => w.workerId === worker.id)}
          now={now}
        />
      ) : (
        <AcrossWorkers instance={instance} workers={workers} now={now} />
      )}
    </View>
  );
}
