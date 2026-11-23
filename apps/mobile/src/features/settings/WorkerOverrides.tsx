import { useState } from "react";
import { Text } from "react-native";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderConfigurationMode, ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ProxyPicker } from "../providers/ProxyPicker";
import { SettingsActions, SettingsSection, SettingToggle } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentFields, environmentDrafts, environmentInput } from "./EnvironmentFields";
import { CodexHomeField } from "./CodexHomeField";
import { ProviderSettingsEditor } from "./ProviderSettingsEditor";
import { providerSettingsError } from "./provider-settings-error";
import { useProviderSettingsDraft } from "./useProviderSettingsDraft";

/**
 * One worker's overrides of an instance (web: OverrideForm): another saved proxy, paths and arguments for its
 * system, and variables added or replaced by name. Empty fields follow the definition (shown as placeholders).
 */
export function WorkerOverrides({
  instance,
  worker,
  onSaved,
}: {
  instance: ui.ProviderInstance;
  worker: ui.Worker;
  onSaved: () => void;
}) {
  const resource = useSettingsResource(
    `GetInstanceWorker:${worker.id}/${instance.harness}/${instance.id}`,
    (api) => api.getInstanceWorker({ workerId: worker.id, harness: instance.harness, id: instance.id }),
    true,
    providerSettingsError,
  );

  const stored = resource.data?.worker;

  return (
    <ResourceState resource={resource}>
      {stored || resource.initialLoading ? (
        <OverrideFields
          key={`${worker.id}/${resource.data ? "loaded" : "loading"}/${stored?.overrides?.proxyId ?? ""}`}
          instance={instance}
          worker={worker}
          overrides={stored?.overrides}
          inherited={resource.data?.inheritedRuntime ?? instance.runtime}
          busy={resource.busy}
          error={resource.inlineError}
          save={async (overrides) => {
            const result = await resource.run((api) =>
              api.setInstanceWorker({ workerId: worker.id, harness: instance.harness, id: instance.id, overrides }),
            );

            if (result) onSaved();

            return !!result;
          }}
        />
      ) : null}
    </ResourceState>
  );
}

type Overrides = MessageInitShape<typeof ui.InstanceOverridesInputSchema>;

interface OverrideFieldsProps {
  instance: ui.ProviderInstance;
  worker: ui.Worker;
  overrides: ui.InstanceOverrides | undefined;
  inherited: ui.InstanceRuntime | undefined;
  busy: boolean;
  error: string;
  save: (overrides: Overrides) => Promise<boolean>;
}

function OverrideFields({ instance, worker, overrides, inherited, busy, error, save }: OverrideFieldsProps) {
  const c = useColors();
  const [userConfiguration, setUserConfiguration] = useState(overrides?.userConfiguration);
  const [binaryPath, setBinary] = useState(overrides?.binaryPath ?? "");
  const [homePath, setHome] = useState(overrides?.homePath ?? "");
  const [shadowHomePath, setShadow] = useState(overrides?.shadowHomePath ?? "");
  const [launchArgs, setArgs] = useState(overrides?.launchArgs.join("\n") ?? "");
  const [argsSet, setArgsSet] = useState(overrides?.launchArgsSet ?? false);
  const [proxyId, setProxy] = useState(overrides?.proxyId ?? "");
  const [env, setEnv] = useState(environmentDrafts(overrides?.env ?? []));
  const settings = useProviderSettingsDraft(instance.harness, overrides?.settingsText);

  const discard = () => {
    setUserConfiguration(overrides?.userConfiguration);
    setBinary(overrides?.binaryPath ?? "");
    setHome(overrides?.homePath ?? "");
    setShadow(overrides?.shadowHomePath ?? "");
    setArgs(overrides?.launchArgs.join("\n") ?? "");
    setArgsSet(overrides?.launchArgsSet ?? false);
    setProxy(overrides?.proxyId ?? "");
    setEnv(environmentDrafts(overrides?.env ?? []));
    settings.change(undefined);
  };

  async function saveOverrides() {
    if (!settings.canSave()) return;

    const saved = await save({
      ...(binaryPath.trim() && { binaryPath: binaryPath.trim() }),
      ...(homePath.trim() && { homePath: homePath.trim() }),
      ...(shadowHomePath.trim() && { shadowHomePath: shadowHomePath.trim() }),
      launchArgsSet: argsSet,
      launchArgs: launchArgs.split("\n").filter(Boolean),
      ...(proxyId && { proxyId }),
      env: environmentInput(env),
      settingsText: settings.settingsText,
      userConfiguration,
    });

    if (saved) settings.change(undefined);
  }

  return (
    <>
      {instance.kind === ProviderProfileKind.CLIPROXYAPI && (
        <SettingsSection
          title={`Connection on ${worker.name}`}
          description="Choose another saved proxy, or follow the instance's connection."
        >
          <ProxyPicker harness={instance.harness} value={proxyId} onChange={setProxy} inherited />
        </SettingsSection>
      )}
      <SettingsSection
        title={`Runtime on ${worker.name}`}
        description="Empty fields follow the definition (shown greyed out)."
      >
        {instance.harness === Provider.CODEX &&
          instance.kind === ProviderProfileKind.NATIVE &&
          !inherited?.ownLogin && (
            <CodexHomeField
              instanceId={instance.id}
              value={userConfiguration}
              inherited={inherited?.userConfiguration?.mode ?? ProviderConfigurationMode.UNSPECIFIED}
              onChange={setUserConfiguration}
            />
          )}
        {path("CLI path", binaryPath, setBinary, inherited?.binaryPath)}
        {path("CLI home path", homePath, setHome, inherited?.homePath)}
        {path(
          instance.harness === Provider.CODEX ? "Private state directory" : "Shadow home path",
          shadowHomePath,
          setShadow,
          inherited?.shadowHomePath,
        )}
        <SettingToggle title="Override launch arguments" value={argsSet} onChange={setArgsSet} />
        {argsSet && (
          <Field
            label="Launch arguments · one per line"
            value={launchArgs}
            onChangeText={setArgs}
            placeholder={inherited?.launchArgs.join("\n")}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
      </SettingsSection>
      <ProviderSettingsEditor
        harness={instance.harness}
        value={settings.value}
        onChange={settings.change}
        problem={settings.problem}
        worker={{ name: worker.name, inherited: inherited?.settingsText }}
        busy={busy}
      />
      <SettingsSection
        title={`Environment on ${worker.name}`}
        description="Added to the definition's variables; the same name replaces one."
      >
        {instance.env.length > 0 && (
          <Text style={[styles.workMeta, { color: c.muted }]}>
            Definition: {instance.env.map((v) => (v.secret ? `${v.name}=••••` : `${v.name}=${v.value}`)).join("  ")}
          </Text>
        )}
        <EnvironmentFields value={env} onChange={setEnv} />
      </SettingsSection>
      {!!error && <Notice error>{error}</Notice>}
      <SettingsActions>
        <Button variant="ghost" title="Discard changes" onPress={discard} />
        <Button
          variant="primary"
          title={`Save for ${worker.name}`}
          busy={busy}
          disabled={settings.saveBlocked}
          onPress={() => void saveOverrides()}
        />
      </SettingsActions>
    </>
  );
}

function path(label: string, value: string, set: (v: string) => void, placeholder = "") {
  return (
    <Field
      label={label}
      value={value}
      onChangeText={set}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}
