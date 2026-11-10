import { View } from "react-native";
import { Markdown } from "../../ui/markdown";
import { SettingsGroup } from "./SettingsGroup";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { mobileFontOptions } from "./mobile-fonts";

export function TypographySettings() {
  return (
    <View style={{ gap: 24 }}>
      <SettingsGroup title="Typography" description="This device · Choose from built-in fonts.">
        <DeviceChoiceRow
          preference="interfaceFont"
          title="Interface font"
          description="Set the typeface for navigation, controls and messages."
          options={mobileFontOptions("interface")}
          search="Search fonts"
        />
        <DeviceChoiceRow
          preference="interfaceSize"
          title="Interface size"
          description="Scale interface text from the desktop base size."
          options={[12, 14, 16, 18].map((v) => ({ value: String(v), label: `${v} px` }))}
        />
        <DeviceChoiceRow
          preference="monoFont"
          title="Monospace font"
          description="Set the typeface for code, diffs and terminal output."
          options={mobileFontOptions("mono")}
          search="Search fonts"
        />
        <DeviceChoiceRow
          preference="monoSize"
          title="Monospace size"
          description="Set the text size for code, diffs and terminal output."
          options={[12, 13, 14, 16].map((v) => ({ value: String(v), label: `${v} px` }))}
        />
        <DeviceChoiceRow
          preference="wrapCode"
          title="Wrap code blocks"
          description="Fit long lines in message code blocks to the available width."
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
        />
        <DeviceChoiceRow
          preference="wrapDiffs"
          title="Wrap diffs"
          description="Fit long lines in diffs to the available width."
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
        />
      </SettingsGroup>
      <SettingsGroup title="Previews">
        <View>
          <Markdown
            text={
              'The agent can explain **changes**.\n\n```ts\nconst message = "A long code line follows your code wrapping preference without changing the saved source.";\n```\n\n```diff\n--- a/settings.ts\n+++ b/settings.ts\n@@ -1 +1 @@\n-const theme = "light";\n+const theme = "system";\n```\n\n```sh\n$ bun run build\nBuilt successfully in 1.2s\nReady.\n```'
            }
          />
        </View>
      </SettingsGroup>
    </View>
  );
}
