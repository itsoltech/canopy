import { Pressable, Text, View } from "react-native";
import { ui } from "@canopy/contracts";
import { themeNames, themes, type ThemeMode } from "@canopy/ui/themes";
import { useAppearance } from "../../state/appearance";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { colorThemes, themeOf } from "./appearance";
import { ThemePreview } from "./ThemePreview";
import { TypographySettings } from "./TypographySettings";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { appearanceDeviceKeys, useDevicePreferences } from "./device-preferences";
import { Button } from "../../ui/components";

export function AppearanceSettings() {
  const c = useColors();
  const settings = useAppearance();
  const device = useDevicePreferences();

  return (
    <View style={{ gap: 24 }}>
      <Button title="Restore device defaults" secondary onPress={() => device.reset(appearanceDeviceKeys)} />
      <SettingsGroup title="Colors" description="Account">
        <SettingsRow title="Color scheme" description="Follow the system or use a fixed light or dark palette.">
          <View style={[styles.row, { alignItems: "stretch" }]}>
            {(
              [
                { label: "System", value: ui.ColorScheme.SYSTEM },
                { label: "Light", value: ui.ColorScheme.LIGHT },
                { label: "Dark", value: ui.ColorScheme.DARK },
              ] as const
            ).map(({ label, value }) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{
                  checked: (settings.appearance?.colorScheme || ui.ColorScheme.SYSTEM) === value,
                  disabled: settings.saving,
                }}
                disabled={settings.saving}
                onPress={() => void settings.updateAppearance({ colorScheme: value })}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: 6,
                  gap: 6,
                  borderWidth: 1,
                  borderRadius: 8,
                  borderColor:
                    (settings.appearance?.colorScheme || ui.ColorScheme.SYSTEM) === value ? c.accent : c.line,
                }}
              >
                <View style={{ overflow: "hidden", borderRadius: 6 }}>
                  <ThemePreview
                    theme={themeOf(settings.appearance, value === ui.ColorScheme.DARK ? "dark" : "light")}
                    mode={value === ui.ColorScheme.DARK ? "dark" : "light"}
                  />
                  {value === ui.ColorScheme.SYSTEM && (
                    <View
                      style={{ position: "absolute", left: "50%", right: 0, top: 0, bottom: 0, overflow: "hidden" }}
                    >
                      <ThemePreview theme={themeOf(settings.appearance, "dark")} mode="dark" />
                    </View>
                  )}
                </View>
                <Text style={[styles.chrome, { textAlign: "center", color: c.text }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Themes" description="Account · Your color scheme decides which palette Canopy shows.">
        <View style={{ flexDirection: "row", padding: 12, gap: 12 }}>
          <ThemeColumn mode="light" />
          <ThemeColumn mode="dark" />
        </View>
      </SettingsGroup>
      <SettingsGroup title="Interface" description="This device unless marked Account">
        <DeviceChoiceRow
          preference="contrast"
          title="Contrast"
          description="Strengthen muted text and borders in both color schemes."
          options={[
            { value: "standard", label: "Standard" },
            { value: "strong", label: "Strong" },
            { value: "maximum", label: "Maximum" },
          ]}
        />
        <DeviceChoiceRow
          preference="effortDisplay"
          title="Effort display"
          description="Show reasoning effort as names or bars in model controls."
          options={[
            { value: "name", label: "Name" },
            { value: "bars", label: "Bars" },
          ]}
        />
        <SettingsRow title="Render math" description="Show LaTeX formulas in messages and previews.">
          <Text style={[styles.chrome, { color: c.muted }]}>Unavailable on mobile · Formulas show their source.</Text>
        </SettingsRow>
        <SettingsRow title="Animated mascots" description="Animate bot mascots in lists and chats.">
          <Text style={[styles.chrome, { color: c.muted }]}>Unavailable on mobile · Mascots stay still.</Text>
        </SettingsRow>
        <SettingChoice
          title="Thread width"
          description="Set the width of threads and their message boxes."
          value={settings.appearance?.chatWidth || ui.ChatWidth.COMFORTABLE}
          options={[
            { value: ui.ChatWidth.COMFORTABLE, label: "Comfortable" },
            { value: ui.ChatWidth.WIDE, label: "Wide" },
            { value: ui.ChatWidth.FULL, label: "Full width" },
          ]}
          disabled={settings.saving}
          onChange={(chatWidth) => void settings.updateAppearance({ chatWidth })}
        />
      </SettingsGroup>
      <TypographySettings />
    </View>
  );
}

function ThemeColumn({ mode }: { mode: ThemeMode }) {
  const c = useColors();
  const settings = useAppearance();
  const selected = themeOf(settings.appearance, mode);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`${mode === "light" ? "Light" : "Dark"} theme`}
      style={{ flex: 1, minWidth: 0, gap: 8 }}
    >
      <Text style={[styles.chrome, { color: c.text, fontFamily: font.medium }]}>
        {mode === "light" ? "Light" : "Dark"} · {themes[selected].label}
      </Text>
      {themeNames.map((name) => (
        <Pressable
          key={name}
          accessibilityRole="radio"
          accessibilityLabel={`${themes[name].label}, ${mode} theme`}
          accessibilityState={{ checked: selected === name, disabled: settings.saving }}
          disabled={settings.saving}
          onPress={() =>
            void settings.updateAppearance(
              mode === "light" ? { lightTheme: colorThemes[name] } : { darkTheme: colorThemes[name] },
            )
          }
          style={{
            minWidth: 0,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: selected === name ? c.accent : c.line,
            padding: 6,
            gap: 4,
          }}
        >
          <ThemePreview theme={name} mode={mode} />
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Text style={[styles.chrome, { flexShrink: 1, color: c.text }]}>{themes[name].label}</Text>
            <View style={{ width: 16 }}>{selected === name && <Icon name="check" size={14} color={c.accent} />}</View>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
