import { Button } from "../../ui/components";
import { useMobilePush } from "../notifications/PushProvider";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { useDevicePreferences } from "./device-preferences";
import { MobilePushSettings } from "./MobilePushSettings";
import { SettingsGroup } from "./SettingsGroup";

export function NotificationSettings() {
  const device = useDevicePreferences();
  const push = useMobilePush();

  return (
    <SettingsGroup
      title="This device"
      actions={
        <Button
          title="Restore device defaults"
          icon="arrow-path"
          size="sm"
          disabled={!device.loaded || push.state?.saving}
          onPress={() => {
            device.reset(["inAppNotifications"]);

            if (push.state?.requested) void push.registration?.setEnabled(false);
          }}
        />
      }
    >
      <MobilePushSettings />
      <DeviceChoiceRow
        preference="inAppNotifications"
        title="In-app notifications"
        description="Show alerts for new habit suggestions and activity in other threads and chats while Canopy is open."
        options={[
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
      />
    </SettingsGroup>
  );
}
