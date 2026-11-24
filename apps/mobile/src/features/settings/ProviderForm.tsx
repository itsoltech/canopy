import { ClaudeConfigurationFields } from "./ClaudeConfigurationFields";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { antigravityDeviceLogin } from "@canopy/ui/providers";
import { SettingsValue } from "./SettingsValue";
import { Button, Field, Notice } from "../../ui/components";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { SettingsActions, SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { CodexHomeField } from "./CodexHomeField";
import { MoveEnvironment } from "./MoveEnvironment";
import { ProxyPicker } from "../providers/ProxyPicker";
import { SettingAccess } from "./SettingAccess";
import { ResourceState } from "./resource";
import { EnvironmentFields } from "./EnvironmentFields";
import { ProviderSettingsEditor } from "./ProviderSettingsEditor";
import { useProviderForm } from "./useProviderForm";
import { SettingsDisclosure } from "./SettingsDisclosure";

const deviceLoginText = (harness: Provider) =>
  harness === Provider.GROK
    ? "Grok CLI's login on the device (grok login), or XAI_API_KEY in its variables."
    : harness === Provider.CODEX
      ? "Use the device's login or sign in here."
      : "Claude Code's login on the device (or a key in its variables).";

export function ProviderForm({
  instance,
  harness,
  onSaved,
  onDiscard,
}: {
  instance: ui.ProviderInstance;
  harness: Provider;
  onSaved: () => void;
  onDiscard: () => void;
}) {
  const draft = useProviderForm({ instance, harness, onSaved });

  return (
    <ResourceState resource={draft.resource}>
      <ProviderIdentity draft={draft} editing />
      <ProviderConfiguration draft={draft} harness={harness} instance={instance} onSaved={onSaved} />
      <SettingsActions>
        <Button variant="ghost" title="Discard changes" disabled={draft.resource.busy} onPress={onDiscard} />
        <Button
          variant="primary"
          title="Save for all workers"
          busy={draft.resource.busy}
          disabled={!draft.ready}
          onPress={() => void draft.save()}
        />
      </SettingsActions>
    </ResourceState>
  );
}

type Draft = ReturnType<typeof useProviderForm>;

export function ProviderConfiguration({
  draft,
  harness,
  instance,
  onSaved,
}: {
  draft: Draft;
  harness: Provider;
  instance?: ui.ProviderInstance;
  onSaved: () => void;
}) {
  const { resource, id, kind, proxyId, runtime, settings, env, allWorkers, workerIds } = draft;
  const workerOptions = useWorkerRecordOptions(resource.data?.records ?? []);
  const runtimeFields = <ProviderRuntime runtime={runtime} onChange={draft.setRuntime} harness={harness} />;

  return (
    <>
      <SettingsGroup
        title="Connection"
        description={harness === Provider.ANTIGRAVITY ? undefined : "Connection changes apply from the next turn."}
      >
        {harness === Provider.ANTIGRAVITY ? (
          <SettingsValue title="Device login" value={antigravityDeviceLogin} />
        ) : (
          <SettingChoice
            title="Connection"
            value={kind}
            disabled={instance?.builtIn}
            onChange={draft.setKind}
            options={[
              { value: ProviderProfileKind.CLIPROXYAPI, label: "Proxy", description: "A saved compatible connection." },
              { value: ProviderProfileKind.NATIVE, label: "Device login", description: deviceLoginText(harness) },
            ]}
          />
        )}
        {harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE && (
          <SettingToggle
            title="Own login"
            description="Sign in with ChatGPT in a separate session home. Changing this home may start fresh sessions."
            value={runtime.ownLogin}
            onChange={(ownLogin) => draft.setRuntime({ ...runtime, ownLogin })}
          />
        )}
        {harness === Provider.CODEX && kind === ProviderProfileKind.NATIVE && !runtime.ownLogin && (
          <CodexHomeField
            instanceId={id}
            value={runtime.userConfiguration}
            onChange={(userConfiguration) => draft.setRuntime({ ...runtime, userConfiguration })}
          />
        )}
      </SettingsGroup>
      {harness !== Provider.ANTIGRAVITY && kind === ProviderProfileKind.CLIPROXYAPI && (
        <ProxyPicker harness={harness} value={proxyId} onChange={draft.setProxy} />
      )}
      {harness === Provider.CLAUDE && (
        <SettingsGroup title="Claude configuration">
          <ClaudeConfigurationFields
            value={runtime.userConfiguration}
            onChange={(userConfiguration) => draft.setRuntime({ ...runtime, userConfiguration })}
          />
        </SettingsGroup>
      )}
      {instance ? (
        runtimeFields
      ) : (
        <SettingsDisclosure title={harness === Provider.ANTIGRAVITY ? "Runtime" : "Runtime and launch arguments"}>
          {runtimeFields}
        </SettingsDisclosure>
      )}
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
        <EnvironmentFields problems={draft.problems} value={env} onChange={draft.setEnv} />
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
              draft.setAll(next.all);
              draft.setWorkers(next.all ? [] : [...next.ids]);
            }}
          />
        </SettingsGroup>
      )}
      {resource.inlineError ? <Notice error>{resource.inlineError}</Notice> : null}
    </>
  );
}

export function ProviderIdentity({ draft, editing = false }: { draft: Draft; editing?: boolean }) {
  const { id, label, setLabel, accentColor: accent, setAccent, setId } = draft;

  return (
    <SettingsGroup title="Identity">
      <Field label="Display name" value={label} onChangeText={setLabel} />
      <Field
        label="Instance ID"
        placeholder="Lowercase letters, numbers, dashes or underscores"
        value={id}
        onChangeText={(value) => setId(value.toLowerCase())}
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
      {harness !== Provider.ANTIGRAVITY && (
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
      )}
      <Field
        label={
          harness === Provider.ANTIGRAVITY
            ? "Managed skills home"
            : harness === Provider.CODEX
              ? "Private state directory"
              : "Shadow home path"
        }
        value={runtime.shadowHomePath}
        onChangeText={(shadowHomePath) => onChange({ ...runtime, shadowHomePath })}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {harness !== Provider.ANTIGRAVITY && (
        <Field
          label="Launch arguments · one per line"
          value={runtime.launchArgs}
          onChangeText={(launchArgs) => onChange({ ...runtime, launchArgs })}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
    </SettingsGroup>
  );
}
