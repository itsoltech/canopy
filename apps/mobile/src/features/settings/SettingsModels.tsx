import { useState } from "react";
import { Provider, type ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { ModelPickerSheet, EffortPickerSheet } from "../models/ModelPicker";
import { modelSections, providerName, type ModelChoice } from "../models/catalog";
import { SelectField } from "../../ui/Picker";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingChoice, SettingsRowScope } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResetSetting } from "./ResetSetting";

export function SettingsModel({
  value,
  onChange,
  provider,
  workerId,
  effort = true,
  hideLabel = false,
}: {
  value: { provider: Provider; profileId: string; model: string; effort?: string };
  onChange: (v: ModelChoice, effort: string) => void;
  provider?: Provider;
  workerId?: string;
  effort?: boolean;
  hideLabel?: boolean;
}) {
  const { workers } = useOverview();

  const resource = useSettingsResource(`ListModels:${workerId ?? "all"}`, (api) =>
    api.listModels({ workerId: workerId ?? "" }),
  );

  const [picker, setPicker] = useState<"model" | "effort">();

  const sections = [
    ...new Map(
      workers
        .flatMap((worker) =>
          modelSections(worker, resource.data?.workers.find((w) => w.workerId === worker.id)?.profiles ?? []),
        )
        .filter(
          (s) =>
            (!provider || s.provider === provider) &&
            (!workerId ||
              workers
                .find((w) => w.id === workerId)
                ?.providerInstances.some(
                  (i) => i.harness === s.provider && (i.id === "native" ? "" : i.id) === s.profileId,
                )),
        )
        .map((s) => [s.key, s]),
    ).values(),
  ];

  const choice = sections
    .flatMap((s) => s.choices)
    .find((c) => c.provider === value.provider && c.profileId === value.profileId && c.model === value.model);

  return (
    <ResourceState resource={resource} gap={12}>
      <SelectField
        label="Model"
        hideLabel={hideLabel}
        value={choice?.name || value.model || "Default model"}
        onPress={() => setPicker("model")}
      />
      {effort && choice && (
        <SelectField
          label="Reasoning effort"
          value={value.effort || choice.defaultEffort || "Default"}
          onPress={() => setPicker("effort")}
        />
      )}
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={() => setPicker(undefined)}
        sections={sections}
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
}: {
  value: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void;
}) {
  const { workers } = useOverview();

  const instances = [
    ...new Map(
      workers
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
            changed={!!value.providerProfileId}
            onReset={() => onChange({ providerProfileId: "" })}
          />
        }
        value={value.providerProfileId}
        disabled={!value.provider}
        options={[
          { value: "", label: "First available" },
          ...instances.flatMap((i) => (i.id === "native" ? [] : [{ value: i.id, label: i.label || i.id }])),
        ]}
        onChange={(providerProfileId) => onChange({ providerProfileId })}
      />
      <DefaultModel provider={value.provider} value={value} onChange={onChange} />
    </>
  );
}

function DefaultModel({
  provider,
  value,
  onChange,
}: {
  provider: Provider;
  value: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void;
}) {
  const { workers } = useOverview();
  const resource = useSettingsResource("ListModels:all", (api) => api.listModels({}));
  const model = value.models.find((m) => m.provider === provider)?.model ?? "";

  const suggestions = [
    ...new Map(
      workers
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
          <ResetSetting label={`Reset ${providerName(provider)} model`} changed={!!model} onReset={() => save("")} />
        ),
      }}
    >
      <SettingsInput
        title="Model"
        description="Leave empty to use the profile's default for new threads."
        value={model}
        suggestions={suggestions}
        onSave={async (value) => {
          save(value);

          return true;
        }}
      />
    </SettingsRowScope.Provider>
  );
}
