import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { colorSchemePreference, deviceAppearanceDefaults, threadWidthPreference } from "@canopy/domain";
import { ui } from "@canopy/contracts";
import { themeNames, themes, type ThemeMode } from "@canopy/ui/themes";
import { useAppearance } from "../../state/appearance";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { colorThemes, themeOf } from "./appearance";
import { ThemePreview } from "./ThemePreview";
import { TypographySettings } from "./TypographySettings";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { appearanceDeviceKeys, useDevicePreferences } from "./device-preferences";
import { Button, Notice } from "../../ui/components";
import { Skeleton, SkeletonScope } from "../../ui/Skeleton";
import { ResetSetting } from "./ResetSetting";
import { ContrastSetting } from "./ContrastSetting";
import { SettingsTopics } from "./SettingsTopics";

export function AppearanceSettings() {
  const device = useDevicePreferences();
  const { appearance } = device;

  return (
    <View style={{ gap: 24 }}>
      <View style={{ gap: 8 }}>
        {appearance.error ? (
          <>
            <Notice error>{appearance.error}</Notice>
            <Button title="Retry appearance settings" onPress={appearance.retry} style={{ alignSelf: "flex-start" }} />
          </>
        ) : null}
        <Button
          title="Reset appearance"
          icon="arrow-path"
          size="sm"
          style={{ alignSelf: "flex-end" }}
          disabled={!appearance.editable || !device.loaded}
          onPress={() => {
            appearance.reset();
            device.reset(appearanceDeviceKeys);
          }}
        />
      </View>
      <SettingsTopics
        topics={[
          { id: "themes", label: "Themes", content: <ThemeSettings /> },
          { id: "interface", label: "Interface", content: <InterfaceSettings /> },
          { id: "typography", label: "Typography", content: <TypographySettings /> },
        ]}
      />
    </View>
  );
}

function ThemeSettings() {
  const { appearance } = useDevicePreferences();

  return (
    <SkeletonScope loading={appearance.loading}>
      <View style={{ gap: 24 }}>
        <ColorSchemeSettings />
        <SettingsGroup title="Themes">
          <View style={{ flexDirection: "row", gap: 12 }}>
            <ThemeColumn mode="light" />
            <ThemeColumn mode="dark" />
          </View>
        </SettingsGroup>
      </View>
    </SkeletonScope>
  );
}

function InterfaceSettings() {
  const { botsEnabled, threadsEnabled } = useAppearance();
  const { appearance } = useDevicePreferences();

  return (
    <SettingsGroup title={threadWidthPreference.group}>
      <ContrastSetting />
      <DeviceChoiceRow
        preference="effortDisplay"
        title="Effort display"
        description="Show reasoning effort as names or bars in model controls."
        options={[
          { value: "name", label: "Name" },
          { value: "bars", label: "Bars" },
        ]}
      />
      {threadsEnabled && (
        <DeviceChoiceRow
          preference="contextDisplay"
          title="Context display"
          description="Show the latest reported context use in every thread’s message box on this device."
          options={[
            { value: "off", label: "Off" },
            { value: "circle", label: "Circle" },
            { value: "text", label: "Text" },
            { value: "bar", label: "Bar" },
            { value: "percentage", label: "Percentage" },
          ]}
        />
      )}
      <SettingsRow
        title="Render math"
        description="Messages show LaTeX source on mobile. Markdown file previews render formulas."
      />
      {botsEnabled && (
        <SettingsRow title="Animated mascots" description="Bot mascots stay still in mobile lists and chats." />
      )}
      {threadsEnabled && (
        <SkeletonScope loading={appearance.loading}>
          <SettingChoice
            title={threadWidthPreference.label}
            description={threadWidthPreference.description}
            value={appearance.values.chatWidth}
            options={Object.values(threadWidthPreference.choices)}
            disabled={!appearance.editable}
            accessory={
              <ResetSetting
                label="Reset thread width"
                disabled={!appearance.editable}
                changed={appearance.values.chatWidth !== deviceAppearanceDefaults.chatWidth}
                onReset={() => appearance.update({ chatWidth: deviceAppearanceDefaults.chatWidth })}
              />
            }
            onChange={(chatWidth) => appearance.update({ chatWidth })}
          />
        </SkeletonScope>
      )}
    </SettingsGroup>
  );
}

function ColorSchemeSettings() {
  const c = useColors();
  const { appearance } = useDevicePreferences();

  return (
    <SettingsGroup title={colorSchemePreference.group}>
      <SettingsRow
        title={colorSchemePreference.label}
        accessory={
          <ResetSetting
            label="Reset color scheme"
            disabled={!appearance.editable}
            changed={appearance.values.colorScheme !== deviceAppearanceDefaults.colorScheme}
            onReset={() => appearance.update({ colorScheme: deviceAppearanceDefaults.colorScheme })}
          />
        }
        controlWidth={320}
        control={
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={colorSchemePreference.label}
            style={[styles.row, { alignItems: "stretch" }]}
          >
            {Object.values(colorSchemePreference.choices).map(({ label, value }) => {
              const checked = appearance.values.colorScheme === value;
              const mode = value === ui.ColorScheme.DARK ? "dark" : "light";

              return (
                <ThemeTile
                  key={value}
                  label={label}
                  checked={checked}
                  disabled={!appearance.editable}
                  onPress={() => appearance.update({ colorScheme: value })}
                  style={{ flex: 1 }}
                >
                  <View style={{ overflow: "hidden", borderRadius: 6 }}>
                    <ThemePreview theme={themeOf(appearance.values, mode)} mode={mode} />
                    {value === ui.ColorScheme.SYSTEM && (
                      <View
                        style={{ position: "absolute", left: "50%", right: 0, top: 0, bottom: 0, overflow: "hidden" }}
                      >
                        <View style={{ width: "200%", alignSelf: "flex-end" }}>
                          <ThemePreview theme={themeOf(appearance.values, "dark")} mode="dark" />
                        </View>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.chrome, { textAlign: "center", color: c.text }]}>{label}</Text>
                </ThemeTile>
              );
            })}
          </View>
        }
      />
    </SettingsGroup>
  );
}

function ThemeColumn({ mode }: { mode: ThemeMode }) {
  const c = useColors();
  const { appearance } = useDevicePreferences();
  const selected = themeOf(appearance.values, mode);
  const [width, setWidth] = useState(0);
  const type = useTypography();

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`${mode === "light" ? "Light" : "Dark"} theme`}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minWidth: 0, gap: 8 }}
    >
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text style={[styles.chrome, { color: c.text, fontFamily: font.medium, flexShrink: 1 }]}>
          {mode === "light" ? "Light" : "Dark"} · {themes[selected].label}
        </Text>
        <ResetSetting
          label={`Reset ${mode} theme`}
          changed={selected !== "birch"}
          disabled={!appearance.editable}
          onReset={() =>
            appearance.update(mode === "light" ? { lightTheme: colorThemes.birch } : { darkTheme: colorThemes.birch })
          }
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {themeNames.map((name) => (
          <Skeleton key={name} style={{ width: width >= 300 ? (width - 8) / 2 : "100%" }}>
            <ThemeTile
              label={`${themes[name].label}, ${mode} theme`}
              checked={selected === name}
              disabled={!appearance.editable}
              onPress={() =>
                appearance.update(
                  mode === "light" ? { lightTheme: colorThemes[name] } : { darkTheme: colorThemes[name] },
                )
              }
            >
              <ThemePreview theme={name} mode={mode} />
              <Text style={[type.chrome, { color: c.text }]}>{themes[name].label}</Text>
            </ThemeTile>
          </Skeleton>
        ))}
      </View>
    </View>
  );
}

function ThemeTile({
  label,
  checked,
  disabled,
  onPress,
  style,
  children,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onPress: () => void;
  style?: ViewStyle;
  children: ReactNode;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minWidth: 0,
          gap: 4,
          borderRadius: 12,
          padding: checked ? 5 : 6,
          borderWidth: checked ? 2 : 1,
          borderColor: checked ? c.accent : c.line,
          backgroundColor: pressed ? c.pressed : c.surface,
        },
        style,
      ]}
    >
      {children}
      {checked && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 20,
            height: 20,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.action,
          }}
        >
          <Icon name="check" size={14} color={c.onAccent} />
        </View>
      )}
    </Pressable>
  );
}
