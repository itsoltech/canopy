import { useState } from "react";
import type { Provider, ui } from "@canopy/contracts";
import type { ReflectionModelChoice } from "@canopy/domain/reflection-models";
import { SelectField } from "../../ui/Picker";
import { ModelPickerSheet, EffortPickerSheet } from "../models/ModelPicker";
import { providerName } from "../models/catalog";
import { useEffortLabel } from "./display";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

type PickerChoice = ReflectionModelChoice & { key: string; name: string };

function modelKey({ provider, profileId, model }: ReflectionModelChoice) {
  return JSON.stringify([provider, profileId, model]);
}

function profileLabel(provider: Provider, name: string) {
  const label = providerName(provider);

  return label === name ? label : `${label} · ${name}`;
}

function pickerSections(choices: ReflectionModelChoice[]) {
  const sections = new Map<string, { key: string; title: string; choices: PickerChoice[] }>();

  for (const choice of choices) {
    const key = JSON.stringify([choice.provider, choice.profileId]);
    let section = sections.get(key);

    if (!section) {
      section = { key, title: profileLabel(choice.provider, choice.profileName), choices: [] };
      sections.set(key, section);
    }

    section.choices.push({ ...choice, key: modelKey(choice), name: choice.label });
  }

  return [...sections.values()];
}

export function MemoryReflectionModelFields({
  choices,
  selected,
  draft,
  busy,
  onChange,
}: {
  choices: ReflectionModelChoice[];
  selected: ReflectionModelChoice | undefined;
  draft: ui.MemoryReflectionSettings;
  busy: boolean;
  onChange: (patch: Partial<ui.MemoryReflectionSettings>) => void;
}) {
  const [picker, setPicker] = useState<"model" | "effort">();
  const effortLabel = useEffortLabel();

  const profileName =
    selected?.profileName || (draft.profileId && draft.profileId !== "native" ? draft.profileId : "Device login");

  const profile = draft.provider ? profileLabel(draft.provider, profileName) : "";

  const hint = !choices.length
    ? "Sign in to a provider on a connected worker."
    : draft.provider && !selected
      ? `${profile} · Model unavailable. Choose another model.`
      : profile || undefined;

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title="Model"
          description={hint}
          control={
            <SelectField
              label="Model"
              hideLabel
              value={selected?.label || draft.model || (draft.provider ? "Auto" : "Choose a model")}
              disabled={busy || !choices.length}
              onPress={() => setPicker("model")}
            />
          }
        />
        {selected && (selected.efforts.length || draft.effort) ? (
          <SettingsRow
            title="Reasoning effort"
            description={
              draft.effort && !selected.efforts.includes(draft.effort)
                ? "Choose an available effort or use Auto."
                : undefined
            }
            control={
              <SelectField
                label="Reasoning effort"
                hideLabel
                value={draft.effort ? effortLabel(draft.effort) : "Auto"}
                disabled={busy}
                onPress={() => setPicker("effort")}
              />
            }
          />
        ) : null}
      </SettingsGroup>
      <ModelPickerSheet
        visible={picker === "model" && !!choices.length}
        onClose={() => setPicker(undefined)}
        sections={pickerSections(choices)}
        showProfile
        value={selected && modelKey(selected)}
        onSelect={(choice) => {
          if (!selected || modelKey(choice) !== modelKey(selected)) {
            onChange({ provider: choice.provider, profileId: choice.profileId, model: choice.model, effort: "" });
          }
        }}
      />
      <EffortPickerSheet
        visible={picker === "effort" && !!selected}
        onClose={() => setPicker(undefined)}
        choice={selected}
        automatic
        value={draft.effort}
        onSelect={(effort) => onChange({ effort })}
      />
    </>
  );
}
