import { useState } from "react";
import { Text } from "react-native";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Field } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ProxyPicker } from "../providers/ProxyPicker";
import { SettingsActions, SettingsSection, SettingToggle } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { EnvironmentFields, environmentDrafts, environmentInput } from "./EnvironmentFields";

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
  const resource = useSettingsResource(`GetInstanceWorker:${worker.id}/${instance.harness}/${instance.id}`, (api) =>
    api.getInstanceWorker({ workerId: worker.id, harness: instance.harness, id: instance.id }),
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
          save={async (overrides) => {
            const result = await resource.run((api) =>
              api.setInstanceWorker({ workerId: worker.id, harness: instance.harness, id: instance.id, overrides }),
            );

            if (result) onSaved();
          }}
        />
      ) : null}
    </ResourceState>
  );
}

type Overrides = MessageInitShape<typeof ui.InstanceOverridesInputSchema>;

function OverrideFields({
  instance,
  worker,
  overrides,
  inherited,
  busy,
  save,
}: {
  instance: ui.ProviderInstance;
  worker: ui.Worker;
  overrides: ui.InstanceOverrides | undefined;
  inherited: ui.InstanceRuntime | undefined;
  busy: boolean;
  save: (overrides: Overrides) => Promise<void>;
}) {
  const c = useColors();
  const [binaryPath, setBinary] = useState(overrides?.binaryPath ?? "");
  const [homePath, setHome] = useState(overrides?.homePath ?? "");
  const [shadowHomePath, setShadow] = useState(overrides?.shadowHomePath ?? "");
  const [launchArgs, setArgs] = useState(overrides?.launchArgs.join("\n") ?? "");
  const [argsSet, setArgsSet] = useState(overrides?.launchArgsSet ?? false);
  const [proxyId, setProxy] = useState(overrides?.proxyId ?? "");
  const [env, setEnv] = useState(environmentDrafts(overrides?.env ?? []));

  const discard = () => {
    setBinary(overrides?.binaryPath ?? "");
    setHome(overrides?.homePath ?? "");
    setShadow(overrides?.shadowHomePath ?? "");
    setArgs(overrides?.launchArgs.join("\n") ?? "");
    setArgsSet(overrides?.launchArgsSet ?? false);
    setProxy(overrides?.proxyId ?? "");
    setEnv(environmentDrafts(overrides?.env ?? []));
  };

  const path = (label: string, value: string, set: (v: string) => void, placeholder = "") => (
    <Field
      label={label}
      value={value}
      onChangeText={set}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );

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
        {path("CLI path", binaryPath, setBinary, inherited?.binaryPath)}
        {path("CLI home path", homePath, setHome, inherited?.homePath)}
        {path("Shadow home path", shadowHomePath, setShadow, inherited?.shadowHomePath)}
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
      <SettingsActions>
        <Button variant="ghost" title="Discard changes" onPress={discard} />
        <Button
          variant="primary"
          title={`Save for ${worker.name}`}
          busy={busy}
          onPress={() =>
            void save({
              ...(binaryPath.trim() && { binaryPath: binaryPath.trim() }),
              ...(homePath.trim() && { homePath: homePath.trim() }),
              ...(shadowHomePath.trim() && { shadowHomePath: shadowHomePath.trim() }),
              launchArgsSet: argsSet,
              launchArgs: launchArgs.split("\n").filter(Boolean),
              ...(proxyId && { proxyId }),
              env: environmentInput(env),
            })
          }
        />
      </SettingsActions>
    </>
  );
}
