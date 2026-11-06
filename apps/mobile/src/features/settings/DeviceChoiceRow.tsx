import { View } from "react-native";
import { Button } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { deviceDefaults, useDevicePreferences, type DeviceKey } from "./device-preferences";

export function DeviceChoiceRow({
  preference,
  title,
  description,
  options,
}: {
  preference: DeviceKey;
  title: string;
  description: string;
  options: { value: string; label: string }[];
}) {
  const device = useDevicePreferences();

  return (
    <View>
      <SettingChoice
        title={title}
        description={description}
        value={device.values[preference]}
        options={options}
        disabled={!device.loaded}
        onChange={(value) => device.set(preference, value)}
      />
      <View
        style={{
          paddingHorizontal: 12,
          paddingBottom: 8,
          alignItems: "flex-end",
          opacity: device.values[preference] === deviceDefaults[preference] ? 0 : 1,
        }}
      >
        <Button
          secondary
          disabled={device.values[preference] === deviceDefaults[preference]}
          title={`Reset ${title.toLowerCase()}`}
          onPress={() => device.set(preference, deviceDefaults[preference])}
        />
      </View>
    </View>
  );
}
