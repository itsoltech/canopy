import { View } from "react-native";
import { Button } from "../../ui/components";
import { Diff } from "../../ui/Diff";
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
        style={{ alignSelf: "flex-start" }}
        onPress={() => device.reset(diffDeviceKeys)}
      />
      <SettingsGroup title="Diff viewer" description="This device · Applies to file changes and diff code blocks.">
        <DeviceChoiceRow
          preference="diffLayout"
          title="Diff layout"
          description="Show original and updated lines stacked or side by side."
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
          description="Set whether file changes start expanded or collapsed."
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
        <View style={{ padding: 12 }}>
          <Diff
            key={device.values.diffFileState}
            diff={
              "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const count = 1;\n+const count = 2;\n console.log(count);\n@@ -5 +5 @@\n-  render();\n+    render();"
            }
            label="Diff settings preview"
          />
        </View>
      </SettingsGroup>
    </View>
  );
}
