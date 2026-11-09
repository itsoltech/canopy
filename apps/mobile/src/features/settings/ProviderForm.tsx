import { useState } from "react";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Field } from "../../ui/components";
import { SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentFields, environmentDrafts, environmentInput } from "./EnvironmentFields";

function useProviderForm({
  instance,
  harness,
  onSaved,
}: {
  instance?: ui.ProviderInstance;
  harness: Provider;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("ListProxies+ListWorkerRecords", async (api) => {
    const [proxies, records] = await Promise.all([api.listProxies({}), api.listWorkerRecords({})]);

    return { ...proxies, ...records };
  });

  const [id, setId] = useState(instance?.id ?? "");
  const [label, setLabel] = useState(instance?.label ?? "");
  const [accentColor, setAccent] = useState(instance?.accentColor ?? "");
  const [kind, setKind] = useState(instance?.kind ?? ProviderProfileKind.CLIPROXYAPI);
  const [proxyId, setProxy] = useState(instance?.proxyId ?? "");

  const [runtime, setRuntime] = useState({
    binaryPath: instance?.runtime?.binaryPath ?? "",
    homePath: instance?.runtime?.homePath ?? "",
    shadowHomePath: instance?.runtime?.shadowHomePath ?? "",
    launchArgs: instance?.runtime?.launchArgs.join("\n") ?? "",
    ownLogin: instance?.runtime?.ownLogin ?? false,
  });

  const [env, setEnv] = useState(environmentDrafts(instance?.env ?? []));
  const [allWorkers, setAll] = useState(instance?.allWorkers ?? true);
  const [workerIds, setWorkers] = useState(instance?.workers.filter((w) => w.enabled).map((w) => w.workerId) ?? []);

  async function save() {
    const result = await resource.run(async (api) => {
      const saved = await api.saveProviderInstance({
        harness,
        id,
        create: !instance,
        label,
        accentColor,
        kind,
        proxyId,
        env: environmentInput(env),
        runtime: { ...runtime, launchArgs: runtime.launchArgs.split("\n").filter(Boolean) },
        expectedRevision: instance?.revision ?? 0n,
        allWorkers,
        workerIds,
      });

      if (instance) await api.setInstanceWorkers({ harness, id, allWorkers, workerIds });

      return saved;
    });

    setEnv(environmentDrafts(instance?.env ?? []));

    if (result) onSaved();
  }

  return {
    resource,
    id,
    setId,
    label,
    setLabel,
    accentColor,
    setAccent,
    kind,
    setKind,
    proxyId,
    setProxy,
    runtime,
    setRuntime,
    env,
    setEnv,
    allWorkers,
    setAll,
    workerIds,
    setWorkers,
    save,
  };
}

export function ProviderForm({
  instance,
  harness,
  onSaved,
}: {
  instance?: ui.ProviderInstance;
  harness: Provider;
  onSaved: () => void;
}) {
  const {
    resource,
    id,
    setId,
    label,
    setLabel,
    accentColor,
    setAccent,
    kind,
    setKind,
    proxyId,
    setProxy,
    runtime,
    setRuntime,
    env,
    setEnv,
    allWorkers,
    setAll,
    workerIds,
    setWorkers,
    save,
  } = useProviderForm({ instance, harness, onSaved });

  return (
    <ResourceState resource={resource}>
      <ProviderIdentity
        id={id}
        setId={setId}
        label={label}
        setLabel={setLabel}
        accent={accentColor}
        setAccent={setAccent}
        editing={!!instance}
      />
      <SettingsGroup title="Connection">
        <SettingChoice
          title="Connection"
          value={kind}
          disabled={instance?.builtIn}
          onChange={setKind}
          options={[
            { value: ProviderProfileKind.CLIPROXYAPI, label: "Proxy", description: "A saved compatible connection." },
            {
              value: ProviderProfileKind.NATIVE,
              label: "Device login",
              description: "Use the CLI login on the worker.",
            },
          ]}
        />
        {kind === ProviderProfileKind.CLIPROXYAPI && (
          <SettingChoice
            title="Proxy"
            value={proxyId}
            onChange={setProxy}
            options={[
              { value: "", label: "Choose proxy" },
              ...(resource.data?.proxies
                .filter(
                  (p) =>
                    p.kind === "cliproxyapi" ||
                    (harness === Provider.CLAUDE ? p.kind === "anthropic" : p.kind === "openai"),
                )
                .map((p) => ({ value: p.id, label: p.name, description: p.baseUrl })) ?? []),
            ]}
          />
        )}
        {harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE && (
          <SettingToggle
            title="Own login"
            description="Sign in with ChatGPT in a separate session home. Changing this home may start fresh sessions."
            value={runtime.ownLogin}
            onChange={(ownLogin) => setRuntime({ ...runtime, ownLogin })}
          />
        )}
      </SettingsGroup>
      <ProviderRuntime runtime={runtime} onChange={setRuntime} harness={harness} />
      <EnvironmentFields value={env} onChange={setEnv} />
      <SettingsGroup title="Workers">
        <SettingToggle
          title="All workers"
          description="Includes future workers."
          value={allWorkers}
          onChange={setAll}
        />
        {!allWorkers &&
          resource.data?.records.map((worker) => (
            <SettingToggle
              key={worker.workerId}
              title={worker.name}
              value={workerIds.includes(worker.workerId)}
              onChange={(enabled) =>
                setWorkers(enabled ? [...workerIds, worker.workerId] : workerIds.filter((v) => v !== worker.workerId))
              }
            />
          ))}
      </SettingsGroup>
      <SettingsValue title="Saved key" value={instance?.apiKeySet ? "Set · write-only" : "Not set"} />
      <Button
        variant="primary"
        title={instance ? "Save definition" : "Add instance"}
        busy={resource.busy}
        disabled={!id.trim() || (kind === ProviderProfileKind.CLIPROXYAPI && !proxyId)}
        onPress={() => void save()}
      />
    </ResourceState>
  );
}

function ProviderIdentity({
  id,
  setId,
  label,
  setLabel,
  accent,
  setAccent,
  editing,
}: {
  id: string;
  setId: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  accent: string;
  setAccent: (v: string) => void;
  editing: boolean;
}) {
  return (
    <SettingsGroup title="Identity">
      <Field label="Display name" value={label} onChangeText={setLabel} />
      <Field
        label="Instance ID"
        value={id}
        onChangeText={setId}
        editable={!editing}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SettingChoice
        title="Accent"
        value={accent}
        onChange={setAccent}
        options={[
          { value: "", label: "None" },
          { value: "#3b82f6", label: "Blue" },
          { value: "#10b981", label: "Green" },
          { value: "#8b5cf6", label: "Purple" },
          { value: "#f59e0b", label: "Amber" },
          { value: "#f43f5e", label: "Rose" },
          { value: "#06b6d4", label: "Cyan" },
        ]}
      />
    </SettingsGroup>
  );
}

type RuntimeDraft = ReturnType<typeof useProviderForm>["runtime"];

function ProviderRuntime({
  runtime,
  onChange,
  harness,
}: {
  runtime: RuntimeDraft;
  onChange: (v: RuntimeDraft) => void;
  harness: Provider;
}) {
  return (
    <SettingsGroup title="Runtime">
      <Field
        label="CLI path"
        value={runtime.binaryPath}
        onChangeText={(binaryPath) => onChange({ ...runtime, binaryPath })}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={
          harness === Provider.CODEX
            ? "CODEX_HOME path"
            : harness === Provider.GROK
              ? "GROK_HOME path"
              : "Claude config dir"
        }
        value={runtime.homePath}
        onChangeText={(homePath) => onChange({ ...runtime, homePath })}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label="Shadow home path"
        value={runtime.shadowHomePath}
        onChangeText={(shadowHomePath) => onChange({ ...runtime, shadowHomePath })}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label="Launch arguments · one per line"
        value={runtime.launchArgs}
        onChangeText={(launchArgs) => onChange({ ...runtime, launchArgs })}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
    </SettingsGroup>
  );
}
