import { useState } from "react";
import { View } from "react-native";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ProviderProfileKind, ui } from "@canopy/contracts";
import { envListProblems } from "@canopy/domain";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup, SettingToggle } from "./SettingsGroup";

export type EnvironmentDraft = {
  storedName?: string;
  key: number;
  name: string;
  value: string;
  secret: boolean;
  keep: boolean;
};

export const environmentDrafts = (env: readonly ui.ProfileEnvVarSettings[]): EnvironmentDraft[] =>
  env.map((v, key) => ({
    key,
    storedName: v.secret ? v.name : undefined,
    name: v.name,
    value: v.secret ? "" : v.value,
    secret: v.secret,
    keep: v.secret,
  }));

export const environmentInput = (env: EnvironmentDraft[]): MessageInitShape<typeof ui.ProfileEnvVarInputSchema>[] =>
  env.map((v) => ({ name: v.name.trim(), secret: v.secret, ...(!(v.secret && v.keep) && { value: v.value }) }));

export function environmentProblems(kind: ProviderProfileKind, rows: EnvironmentDraft[]) {
  const problems = new Map(
    envListProblems(
      kind === ProviderProfileKind.CLIPROXYAPI ? "endpoint" : "native",
      rows.map((row) => ({ name: row.name.trim(), value: row.keep ? "" : row.value })),
    ).map(({ index, message }) => [rows[index]?.key, message]),
  );

  for (const row of rows)
    if (!problems.has(row.key) && row.secret && !row.keep && !row.value)
      problems.set(row.key, "Enter the secret value.");

  return problems;
}

export function EnvironmentFields({
  value,
  onChange,
  problems,
}: {
  value: EnvironmentDraft[];
  problems: ReturnType<typeof environmentProblems>;
  onChange: (v: EnvironmentDraft[]) => void;
}) {
  const [next, setNext] = useState(Math.max(0, ...value.map((v) => v.key)) + 1);

  const change = (key: number, patch: Partial<EnvironmentDraft>) =>
    onChange(value.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <View style={{ gap: 8 }}>
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
          {row.secret && row.storedName === row.name.trim() && (
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
          {problems.get(row.key) && <Notice error>{problems.get(row.key)}</Notice>}
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
    </View>
  );
}
