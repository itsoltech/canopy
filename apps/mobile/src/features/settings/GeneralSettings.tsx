import { Text, View } from "react-native";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { Badge } from "../../ui/Badge";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { useDevicePreferences } from "./device-preferences";
import { ConfirmationSettings } from "./ThreadListSettings";
import { ModuleSettings } from "./ModuleSettings";
import { AccountConfigNotices } from "./AccountConfigNotices";
import { UsagePingSettings } from "./UsagePingSettings";

export function GeneralSettings() {
  const settings = useAppearance();
  const device = useDevicePreferences();
  const c = useColors();

  return (
    <View style={{ gap: 24 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text style={[styles.workMeta, { color: c.muted, flexShrink: 1 }]}>
          Account preferences follow your configuration group. “This device” stays here.
        </Text>
        <Button
          title="Restore device defaults"
          icon="arrow-path"
          size="sm"
          disabled={!device.loaded}
          onPress={() => device.reset(["timeFormat"])}
        />
      </View>
      <ModuleSettings />
      {!settings.threadsEnabled && <ConfirmationSettings />}
      <DisplaySettings />
      <UsagePingSettings />
      <AccountConfigNotices
        sections={settings.threadsEnabled ? ["modules", "timezone"] : ["modules", "timezone", "general", "sidebar"]}
      />
    </View>
  );
}

function DisplaySettings() {
  const settings = useAppearance();
  const c = useColors();

  return (
    <SettingsGroup title="Display" description="This device unless marked Account">
      <DeviceChoiceRow
        preference="timeFormat"
        title="Time format"
        options={[
          { value: "system", label: "System" },
          { value: "12h", label: "12-hour" },
          { value: "24h", label: "24-hour" },
        ]}
      />
      <SettingsRow
        title="Time zone"
        description="Canopy uses this device’s time zone when scheduling work."
        control={
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
            <Badge>Account</Badge>
            <Text selectable style={[styles.chrome, { color: c.text, flexShrink: 1 }]}>
              {settings.user?.timezone || "UTC"}
            </Text>
          </View>
        }
      />
    </SettingsGroup>
  );
}
