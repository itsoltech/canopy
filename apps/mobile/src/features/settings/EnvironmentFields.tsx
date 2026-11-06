import { useState } from "react";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup, SettingToggle } from "./SettingsGroup";

export type EnvironmentDraft = { key: number; name: string; value: string; secret: boolean; keep: boolean };

export const environmentDrafts = (env: readonly ui.ProfileEnvVarSettings[]) =>
  env.map((v, key) => ({ key, name: v.name, value: v.secret ? "" : v.value, secret: v.secret, keep: v.secret }));

export const environmentInput = (env: EnvironmentDraft[]): MessageInitShape<typeof ui.ProfileEnvVarInputSchema>[] =>
  env.map((v) => ({ name: v.name.trim(), secret: v.secret, ...(!(v.secret && v.keep) && { value: v.value }) }));

export function EnvironmentFields({
  value,
  onChange,
}: {
  value: EnvironmentDraft[];
  onChange: (v: EnvironmentDraft[]) => void;
}) {
  const [next, setNext] = useState(Math.max(0, ...value.map((v) => v.key)) + 1);

  const change = (key: number, patch: Partial<EnvironmentDraft>) =>
    onChange(value.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <SettingsGroup
      title="Environment variables"
      description="Secrets stay encrypted in the gateway. Saved values are never shown again."
    >
      {value.map((row) => (
        <SettingsGroup key={row.key}>
          <Field
            label="Variable name"
            value={row.name}
            editable={!row.keep}
            onChangeText={(name) => change(row.key, { name })}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <SettingToggle
            title="Secret"
            value={row.secret}
            onChange={(secret) => change(row.key, { secret, keep: false, value: "" })}
          />
          {row.secret && (
            <SettingToggle
              title="Keep saved value"
              value={row.keep}
              onChange={(keep) => change(row.key, { keep, value: "" })}
            />
          )}
          {!row.keep && (
            <Field
              label="Value"
              value={row.value}
              secureTextEntry={row.secret}
              onChangeText={(text) => change(row.key, { value: text })}
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}
          {row.keep && <Notice>Saved secret · unchanged</Notice>}
          <Button title="Remove variable" onPress={() => onChange(value.filter((v) => v.key !== row.key))} />
        </SettingsGroup>
      ))}
      <Button
        title="Add variable"
        onPress={() => {
          onChange([...value, { key: next, name: "", value: "", secret: false, keep: false }]);
          setNext(next + 1);
        }}
      />
    </SettingsGroup>
  );
}
