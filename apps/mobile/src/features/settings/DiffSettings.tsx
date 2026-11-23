import { View } from "react-native";
import { Button } from "../../ui/components";
import { SettingsDiffPreview } from "./SettingsDiffPreview";
import { SettingsGroup } from "./SettingsGroup";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { diffDeviceKeys, useDevicePreferences } from "./device-preferences";

export function DiffSettings() {
  const device = useDevicePreferences();

  return (
    <View style={{ gap: 24 }}>
      <Button
        title="Restore device defaults"
        icon="arrow-path"
        size="sm"
        disabled={!device.loaded}
        style={{ alignSelf: "flex-end" }}
        onPress={() => device.reset(diffDeviceKeys)}
      />
      <SettingsGroup title="Diff viewer" description="This device · Applies to file changes and diff code blocks.">
        <DeviceChoiceRow
          preference="diffLayout"
          title="Diff layout"
          options={[
            { value: "stacked", label: "Stacked" },
            { value: "split", label: "Side by side" },
          ]}
        />
        <DeviceChoiceRow
          preference="hideWhitespace"
          title="Hide whitespace changes"
          description="Hide replacements that differ only in spacing."
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
        />
        <DeviceChoiceRow
          preference="diffFileState"
          title="Default file state"
          options={[
            { value: "expanded", label: "Expanded" },
            { value: "collapsed", label: "Collapsed" },
          ]}
        />
        <DeviceChoiceRow
          preference="diffColors"
          title="Diff colors"
          description="Set the colors for additions and deletions."
          options={[
            { value: "red-green", label: "Red & green" },
            { value: "blue-orange", label: "Blue & orange" },
          ]}
        />
      </SettingsGroup>
      <SettingsGroup title="Preview">
        <SettingsDiffPreview
          diff={
            "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const count = 1;\n+const count = 2;\n console.log(count);\n@@ -5 +5 @@\n-  render();\n+    render();"
          }
          label="Diff settings preview"
        />
      </SettingsGroup>
    </View>
  );
}
