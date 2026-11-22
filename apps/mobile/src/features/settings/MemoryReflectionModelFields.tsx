import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import type { PickerOption } from "../../ui/Picker";
import { effortLabel, profileValue, providerName } from "../models/catalog";
import { SettingChoice, SettingsGroup } from "./SettingsGroup";

type Model = ui.MemoryReflectionModel;

type Settings = ui.MemoryReflectionSettings;

type Profile = Pick<Model, "workerId" | "provider" | "profileId">;

function profileKey(profile: Profile) {
  return profile.workerId ? JSON.stringify([profile.workerId, profile.provider, profile.profileId]) : "";
}

function profileLabel(profile: Profile, worker: ui.Worker | undefined, workerName: string) {
  const instance = worker?.providerInstances.find(
    (item) => item.harness === profile.provider && profileValue(item.id) === profileValue(profile.profileId),
  );

  const name = providerName(profile.provider);
  const instanceName = instance?.label || profileValue(profile.profileId) || "Device login";

  return [name === instanceName ? name : name + " · " + instanceName, worker?.name || workerName]
    .filter(Boolean)
    .join(" · ");
}

function availableOptions(options: PickerOption<string>[], value: string, fallback: string) {
  return options.some((option) => option.value === value)
    ? options
    : [{ value, label: fallback, disabled: true, wrapLabel: true }, ...options];
}

export function MemoryReflectionModelFields({
  models,
  draft,
  busy,
  hasProfiles,
  onChange,
}: {
  models: Model[];
  draft: Settings;
  busy: boolean;
  hasProfiles: boolean;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const { workers } = useOverview();
  const selected = profileKey(draft);
  const profiles = new Map(models.map((model) => [profileKey(model), model]));
  const profile = profiles.get(selected);

  const modelChoices = new Map(
    models.filter((model) => profileKey(model) === selected && model.model).map((model) => [model.model, model]),
  );

  const model = modelChoices.get(draft.model);
  const efforts = model?.efforts ?? [];

  const profileOptions = [...profiles].map(([value, profile]) => ({
    value,
    label: profileLabel(
      profile,
      workers.find(({ id }) => id === profile.workerId),
      profile.workerName,
    ),
    wrapLabel: true,
  }));

  const modelOptions = [
    { value: "", label: "Auto" },
    ...[...modelChoices.values()].map((item) => ({
      value: item.model,
      label: item.label || item.model,
      wrapLabel: true,
    })),
  ];

  return (
    <SettingsGroup>
      <SettingChoice
        title="Provider profile"
        description={
          !profiles.size
            ? hasProfiles
              ? "Choose projects that share a worker with an available provider profile."
              : "Sign in to a provider on a connected worker."
            : draft.enabled && !profile
              ? "Choose an available provider profile."
              : undefined
        }
        disabled={busy || !profiles.size}
        value={selected}
        options={availableOptions(profileOptions, selected, selected ? "Unavailable profile" : "Choose a profile")}
        onChange={(key) => {
          const profile = profiles.get(key);

          if (profile && key !== selected)
            onChange({
              workerId: profile.workerId,
              provider: profile.provider,
              profileId: profile.profileId,
              model: "",
              effort: "",
            });
        }}
      />
      <SettingChoice
        title="Model"
        description={profile && draft.model && !model ? "Choose an available model or use Auto." : undefined}
        value={draft.model}
        options={availableOptions(modelOptions, draft.model, draft.model)}
        disabled={busy || !profile}
        onChange={(model) => {
          if (model !== draft.model) onChange({ model, effort: "" });
        }}
      />
      {model && (efforts.length > 0 || draft.effort) ? (
        <SettingChoice
          title="Reasoning effort"
          description={
            draft.effort && !efforts.includes(draft.effort) ? "Choose an available effort or use Auto." : undefined
          }
          value={draft.effort}
          options={availableOptions(
            [{ value: "", label: "Auto" }, ...efforts.map((value) => ({ value, label: effortLabel(value) }))],
            draft.effort,
            effortLabel(draft.effort),
          )}
          disabled={busy}
          onChange={(effort) => onChange({ effort })}
        />
      ) : null}
    </SettingsGroup>
  );
}
