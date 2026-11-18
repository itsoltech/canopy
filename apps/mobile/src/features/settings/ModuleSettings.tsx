import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ModuleId } from "@canopy/domain";
import { moduleChoices, moduleSettingsDescription } from "@canopy/ui/settings";
import { useAppearance } from "../../state/appearance";
import { SettingChoice, SettingsGroup, SettingToggle } from "./SettingsGroup";

export function ModuleSettings() {
  const settings = useAppearance();
  const { modules } = settings;

  if (settings.user && !settings.user.modules) return null;

  const disabled = !settings.user || settings.saving;
  const save = (enabled: ModuleId[]) => void settings.update({ modules: create(ui.ModuleSettingsSchema, { enabled }) });

  return (
    <SettingsGroup title="Modules" description={moduleSettingsDescription}>
      <SettingChoice
        title="First tab"
        description="Canopy opens this tab by default."
        value={modules[0]}
        disabled={disabled || modules.length === 1}
        options={moduleChoices.map(({ value, label }) => ({ value, label, disabled: !modules.includes(value) }))}
        onChange={(value) => save([value, ...modules.filter((id) => id !== value)])}
      />
      {moduleChoices.map((choice) => {
        const on = modules.includes(choice.value);
        const last = on && modules.length === 1;

        return (
          <SettingToggle
            key={choice.value}
            title={choice.label}
            description={last ? `Turn on ${choice.other} before turning off ${choice.label}.` : choice.description}
            value={on}
            disabled={disabled || last}
            onChange={(checked) =>
              save(checked ? [...modules, choice.value] : modules.filter((id) => id !== choice.value))
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
