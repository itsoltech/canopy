import { Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useColors, useTypography } from "../../ui/theme";
import { ResetSetting } from "./ResetSetting";
import { SettingToggle } from "./SettingsGroup";

/**
 * The connected computer's opt-in: its gateway starts Update all once its owner's work is quiet (docs/updates.md).
 * Saved on that gateway; the phone's own updates stay as they are.
 */
export function AutoUpdateSetting({ computerName }: { computerName: string }) {
  const settings = useAppearance();
  const c = useColors();
  const type = useTypography();
  const enabled = settings.user?.appUpdates?.autoUpdate ?? false;
  const disabled = !settings.user || settings.saving;
  const target = computerName ? `“${computerName}”` : "the gateway";

  const change = (autoUpdate: boolean) =>
    void settings.update({ appUpdates: create(ui.AppUpdateSettingsSchema, { autoUpdate }) });

  return (
    <SettingToggle
      title="Automatic updates"
      description={`Canopy runs Update all on ${target} after no turn or background task has run for 5 minutes.`}
      value={enabled}
      disabled={disabled}
      onChange={change}
      accessory={
        <ResetSetting
          label="Reset automatic updates to default"
          changed={enabled}
          disabled={disabled}
          onReset={() => change(false)}
        />
      }
    >
      {enabled && <Text style={[type.meta, { color: c.muted }]}>Computers restart without asking first.</Text>}
    </SettingToggle>
  );
}
