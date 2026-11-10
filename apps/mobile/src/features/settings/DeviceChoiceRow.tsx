import { View } from "react-native";
import { ResetSetting } from "./ResetSetting";
import { SettingChoice } from "./SettingsGroup";
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
  description: string;
  options: PickerOption<string>[];
  search?: string;
}) {
  const device = useDevicePreferences();

  return (
    <View>
      <SkeletonScope loading={!device.loaded && !device.error}>
        <SettingChoice
          title={title}
          description={description}
          value={device.values[preference]}
          options={options}
          search={search}
          disabled={!device.loaded}
          onChange={(value) => device.set(preference, value)}
          accessory={
            <ResetSetting
              label={`Reset ${title.toLowerCase()}`}
              changed={device.values[preference] !== deviceDefaults[preference]}
              onReset={() => device.set(preference, deviceDefaults[preference])}
            />
          }
        />
      </SkeletonScope>
    </View>
  );
}
