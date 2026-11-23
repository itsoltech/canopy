import { ResetSetting } from "./ResetSetting";
import { SettingChoice, SettingOptions, SettingToggle } from "./SettingsGroup";
import { deviceDefaults, useDevicePreferences, type DeviceKey } from "./device-preferences";
import { SkeletonScope } from "../../ui/Skeleton";
import type { PickerOption } from "../../ui/Picker";

export function DeviceChoiceRow({
  preference,
  title,
  description,
  options,
  search,
}: {
  preference: DeviceKey;
  title: string;
  description?: string;
  options: PickerOption<string>[];
  search?: string;
}) {
  const device = useDevicePreferences();
  const value = device.values[preference];
  const save = (next: string) => device.set(preference, next);

  const props = {
    title,
    description,
    disabled: !device.loaded,
    accessory: (
      <ResetSetting
        label={`Reset ${title.toLowerCase()} to default`}
        changed={value !== deviceDefaults[preference]}
        disabled={!device.loaded}
        onReset={() => save(deviceDefaults[preference])}
      />
    ),
  };

  return (
    <SkeletonScope loading={!device.loaded && !device.error}>
      {options.length === 2 && options.every((option) => option.value === "on" || option.value === "off") ? (
        <SettingToggle {...props} value={value === "on"} onChange={(on) => save(on ? "on" : "off")} />
      ) : options.length === 2 ? (
        <SettingOptions {...props} value={value} options={options} onChange={save} />
      ) : (
        <SettingChoice {...props} value={value} options={options} onChange={save} search={search} />
      )}
    </SkeletonScope>
  );
}
