import { useState } from "react";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { SettingsActions, SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { CodexHomeField } from "./CodexHomeField";
import { MoveEnvironment } from "./MoveEnvironment";
import { ProxyPicker } from "../providers/ProxyPicker";
import { SettingAccess } from "./SettingAccess";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentFields, environmentDrafts, environmentInput } from "./EnvironmentFields";
import { ProviderSettingsEditor } from "./ProviderSettingsEditor";
import { providerSettingsError } from "./provider-settings-error";
import { useProviderSettingsDraft } from "./useProviderSettingsDraft";

const deviceLoginText = (harness: Provider) =>
  harness === Provider.GROK
    ? "Grok CLI's login on the device (grok login), or XAI_API_KEY in its variables."
    : harness === Provider.CODEX
      ? "Use the device's login or sign in here."
      : "Claude Code's login on the device (or a key in its variables).";

function useProviderForm({
  instance,
  harness,
  onSaved,
}: {
  instance?: ui.ProviderInstance;
  harness: Provider;
  onSaved: () => void;
}) {
  const resource = useSettingsResource(
    "ListWorkerRecords",
    (api) => api.listWorkerRecords({}),
    true,
    providerSettingsError,
  );

  const [id, setId] = useState(instance?.id ?? "");
  const [label, setLabel] = useState(instance?.label ?? "");
  const [accentColor, setAccent] = useState(instance?.accentColor ?? "");
  const [kind, setKind] = useState(instance?.kind ?? ProviderProfileKind.CLIPROXYAPI);
  const [proxyId, setProxy] = useState(instance?.proxyId ?? "");
  const settings = useProviderSettingsDraft(harness, instance?.runtime?.settingsText);

  const [runtime, setRuntime] = useState({
    binaryPath: instance?.runtime?.binaryPath ?? "",
    homePath: instance?.runtime?.homePath ?? "",
    shadowHomePath: instance?.runtime?.shadowHomePath ?? "",
    launchArgs: instance?.runtime?.launchArgs.join("\n") ?? "",
    ownLogin: instance?.runtime?.ownLogin ?? false,
    userConfiguration: instance?.runtime?.userConfiguration,
  });

  const [env, setEnv] = useState(environmentDrafts(instance?.env ?? []));
  const [allWorkers, setAll] = useState(instance?.allWorkers ?? true);
  const [workerIds, setWorkers] = useState(instance?.workers.filter((w) => w.enabled).map((w) => w.workerId) ?? []);

  async function save() {
    if (!settings.canSave()) return;

    const result = await resource.run((api) =>
      api.saveProviderInstance({
        harness,
        id,
        create: !instance,
        label,
        accentColor,
        kind,
        proxyId,
        env: environmentInput(env),
        runtime: {
          ...runtime,
          launchArgs: runtime.launchArgs.split("\n").filter(Boolean),
          settingsText: settings.settingsText,
        },
        expectedRevision: instance?.revision ?? 0n,
        // Editing: where it runs is chosen in the Status section and saved there.
        allWorkers: instance ? instance.allWorkers : allWorkers,
        workerIds: instance ? instance.workers.filter((w) => w.enabled).map((w) => w.workerId) : workerIds,
      }),
    );

    if (result) {
      setEnv(environmentDrafts(instance?.env ?? []));
      onSaved();
    }
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
    settings,
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
  onDiscard,
}: {
  instance?: ui.ProviderInstance;
  harness: Provider;
  onSaved: () => void;
  onDiscard?: () => void;
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
    settings,
    env,
    setEnv,
    allWorkers,
    setAll,
    workerIds,
    setWorkers,
    save,
  } = useProviderForm({ instance, harness, onSaved });

  const workerOptions = useWorkerRecordOptions(resource.data?.records ?? []);

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
      <SettingsGroup title="Connection" description="Connection changes apply from the next turn.">
        <SettingChoice
          title="Connection"
          value={kind}
          disabled={instance?.builtIn}
          onChange={setKind}
          options={[
            { value: ProviderProfileKind.CLIPROXYAPI, label: "Proxy", description: "A saved compatible connection." },
            { value: ProviderProfileKind.NATIVE, label: "Device login", description: deviceLoginText(harness) },
          ]}
        />
        {harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE && (
          <SettingToggle
            title="Own login"
            description="Sign in with ChatGPT in a separate session home. Changing this home may start fresh sessions."
            value={runtime.ownLogin}
            onChange={(ownLogin) => setRuntime({ ...runtime, ownLogin })}
          />
        )}
        {harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE && !runtime.ownLogin && (
          <CodexHomeField
            instanceId={id}
            value={runtime.userConfiguration}
            onChange={(userConfiguration) => setRuntime({ ...runtime, userConfiguration })}
          />
        )}
      </SettingsGroup>
      {kind === ProviderProfileKind.CLIPROXYAPI && (
        <ProxyPicker harness={harness} value={proxyId} onChange={setProxy} />
      )}
      <ProviderRuntime runtime={runtime} onChange={setRuntime} harness={harness} />
      <ProviderSettingsEditor
        harness={harness}
        value={settings.value}
        onChange={settings.change}
        problem={settings.problem}
        busy={resource.busy}
      />
      <SettingsGroup
        title="Environment"
        description="Variables of the harness process. A secret is stored encrypted and never shown again."
      >
        {instance ? <MoveEnvironment instance={instance} onSaved={onSaved} /> : null}
        <EnvironmentFields value={env} onChange={setEnv} />
      </SettingsGroup>
      {!instance && (
        <SettingsGroup>
          <SettingAccess
            title="Workers"
            description="The instance runs only on the chosen workers."
            options={workerOptions.map((option) => ({ id: option.value, name: option.label }))}
            all={allWorkers}
            ids={workerIds}
            onChange={(next) => {
              setAll(next.all);
              setWorkers(next.all ? [] : [...next.ids]);
            }}
          />
        </SettingsGroup>
      )}
      {resource.inlineError ? <Notice error>{resource.inlineError}</Notice> : null}
      <SettingsActions>
        {onDiscard ? <Button variant="ghost" title="Discard changes" onPress={onDiscard} /> : null}
        <Button
          variant="primary"
          title={instance ? "Save for all workers" : "Add instance"}
          busy={resource.busy}
          disabled={settings.saveBlocked || !id.trim() || (kind === ProviderProfileKind.CLIPROXYAPI && !proxyId)}
          onPress={() => void save()}
        />
      </SettingsActions>
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
    <SettingsGroup title="Runtime" description="For every worker; a worker can override paths for its system.">
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
        label={harness === Provider.CODEX ? "Private state directory" : "Shadow home path"}
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
