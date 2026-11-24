import { useState } from "react";
import { Text, View } from "react-native";
import { Provider, type ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { ModelPickerSheet, EffortPickerSheet } from "../models/ModelPicker";
import { modelSections, providerName, profileValue, type ModelSection, type ModelChoice } from "../models/catalog";
import { SelectField } from "../../ui/Picker";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingChoice, SettingsRowScope } from "./SettingsGroup";
import { useColors, useTypography } from "../../ui/theme";
import { useEffortLabel } from "./display";
import { SettingsInput } from "./SettingsInput";
import { ResetSetting } from "./ResetSetting";

export function SettingsModel({
  value,
  onChange,
  provider,
  workerId,
  effort = true,
  hideLabel = false,
  disabled = false,
  resetEffort,
  localWorkersOnly = false,
  allowProvider,
}: {
  value: { provider: Provider; profileId: string; model: string; effort?: string };
  onChange: (v: ModelChoice, effort: string) => void;
  provider?: Provider;
  workerId?: string;
  effort?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  resetEffort?: () => void;
  localWorkersOnly?: boolean;
  allowProvider?: (provider: Provider) => boolean;
}) {
  const { workers } = useOverview();
  const c = useColors();
  const type = useTypography();
  const effortLabel = useEffortLabel();

  const resource = useSettingsResource(`ListModels:${workerId ?? "all"}`, (api) =>
    api.listModels({ workerId: workerId ?? "" }),
  );

  const [picker, setPicker] = useState<"model" | "effort">();

  const available = workers.filter((worker) =>
    workerId ? worker.id === workerId : !localWorkersOnly || !worker.nodeId,
  );

  const sections = new Map<string, ModelSection>();

  for (const worker of available) {
    for (const section of modelSections(
      worker,
      resource.data?.workers.find((w) => w.workerId === worker.id)?.profiles ?? [],
    )) {
      if ((provider && section.provider !== provider) || (allowProvider && !allowProvider(section.provider))) continue;
      const other = sections.get(section.key);
      sections.set(
        section.key,
        other
          ? {
              ...other,
              choices: [
                ...new Map([...other.choices, ...section.choices].map((choice) => [choice.key, choice])).values(),
              ],
            }
          : section,
      );
    }
  }

  const group = [...sections.values()].find(
    (section) => section.provider === value.provider && section.profileId === profileValue(value.profileId),
  );

  const choice = group?.choices.find((c) => c.model === value.model);

  const instance = available
    .flatMap((worker) => worker.providerInstances)
    .find(
      (instance) => instance.harness === value.provider && profileValue(instance.id) === profileValue(value.profileId),
    );

  return (
    <ResourceState resource={resource} gap={12}>
      <SelectField
        label="Model"
        hideLabel={hideLabel}
        value={choice?.name || value.model || "Default model"}
        disabled={disabled}
        onPress={() => setPicker("model")}
      />
      {effort && (choice?.efforts.length || (resetEffort && !!value.effort)) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {resetEffort && (
            <ResetSetting
              label="Reset text generation effort to default"
              changed={!!value.effort}
              disabled={disabled}
              onReset={resetEffort}
            />
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <SelectField
              label="Reasoning effort"
              value={effortLabel(value.effort || choice?.defaultEffort || "")}
              disabled={disabled || !choice?.efforts.length}
              onPress={() => setPicker("effort")}
            />
          </View>
        </View>
      ) : null}
      {resetEffort && !!value.model && (
        <Text style={[type.meta, { color: c.muted }]}>
          {providerName(value.provider)} · {instance?.label || profileValue(value.profileId) || "Device login"}
        </Text>
      )}
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={() => setPicker(undefined)}
        sections={[...sections.values()]}
        value={choice?.key}
        onSelect={(c) => onChange(c, c.efforts.includes("low") ? "low" : "")}
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={() => setPicker(undefined)}
        choice={choice}
        value={value.effort ?? ""}
        onSelect={(e) => {
          if (choice) onChange(choice, e);
        }}
      />
    </ResourceState>
  );
}

export function DefaultModels({
  value,
  onChange,
  disabled = false,
}: {
  value: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void | Promise<boolean>;
  disabled?: boolean;
}) {
  const { workers } = useOverview();

  const instances = [
    ...new Map(
      workers
        .filter((worker) => !worker.nodeId)
        .flatMap((w) => w.providerInstances)
        .filter((i) => i.harness === value.provider && i.enabled)
        .map((i) => [i.id, i]),
    ).values(),
  ];

  if (!value.provider) return null;

  return (
    <>
      <SettingChoice
        title="Profile"
        description="New threads use this profile to reach the provider."
        accessory={
          <ResetSetting
            label="Reset profile"
            disabled={disabled}
            changed={!!value.providerProfileId}
            onReset={() => void onChange({ providerProfileId: "" })}
          />
        }
        value={value.providerProfileId}
        disabled={disabled || !value.provider}
        options={[
          { value: "", label: "First available" },
          ...instances.flatMap((i) => (i.id === "native" ? [] : [{ value: i.id, label: i.label || i.id }])),
        ]}
        onChange={(providerProfileId) => onChange({ providerProfileId })}
      />
      <DefaultModel
        key={value.provider}
        disabled={disabled}
        provider={value.provider}
        value={value}
        onChange={onChange}
      />
    </>
  );
}

function DefaultModel({
  provider,
  value,
  onChange,
  disabled = false,
}: {
  provider: Provider;
  value: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void | Promise<boolean>;
  disabled?: boolean;
}) {
  const { workers } = useOverview();
  const resource = useSettingsResource("ListModels:all", (api) => api.listModels({}));
  const model = value.models.find((m) => m.provider === provider)?.model ?? "";

  const suggestions = [
    ...new Map(
      workers
        .filter((worker) => !worker.nodeId)
        .flatMap((worker) =>
          modelSections(worker, resource.data?.workers.find((w) => w.workerId === worker.id)?.profiles ?? []),
        )
        .filter((s) => s.provider === provider)
        .flatMap((s) => s.choices)
        .map((c) => [c.model, { value: c.model, label: c.name, keywords: c.model }]),
    ).values(),
  ];

  const save = (model: string) =>
    onChange({
      models: [
        ...value.models.filter((m) => m.provider !== provider),
        { $typeName: "canopy.ui.v1.ProviderModel", provider, model },
      ],
    });

  return (
    <SettingsRowScope.Provider
      value={{
        accessory: (
          <ResetSetting
            disabled={disabled}
            label={`Reset ${providerName(provider)} model`}
            changed={!!model}
            onReset={() => save("")}
          />
        ),
      }}
    >
      <SettingsInput
        title="Model"
        description="Leave empty to use the profile's default for new threads."
        value={model}
        suggestions={suggestions}
        busy={disabled}
        onSave={async (value) => (await save(value)) !== false}
      />
    </SettingsRowScope.Provider>
  );
}
