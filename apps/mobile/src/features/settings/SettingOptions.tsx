import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { Icon } from "../../ui/Icon";
import type { PickerOption } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsRow } from "./SettingsRow";
import { SettingsMatch } from "./SettingsSearch";

/** Web OptionTile group. Tiles wrap onto another line in narrow panes or with large type. */
export function SettingOptions<T extends string | number>({
  title,
  description,
  value,
  options,
  onChange,
  disabled,
  accessory,
}: {
  title: string;
  description?: string;
  value: T;
  options: readonly Pick<PickerOption<T>, "value" | "label" | "disabled" | "description">[];
  onChange: (value: T) => void;
  disabled?: boolean;
  accessory?: ReactNode;
}) {
  const c = useColors();
  const type = useTypography();
  const { fontScale } = useWindowDimensions();

  return (
    <SettingsRow
      title={title}
      description={description}
      accessory={accessory}
      controlWidth={288}
      control={
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={title}
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {options.map((option) => {
            const checked = value === option.value;
            const inactive = disabled || option.disabled;

            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityLabel={`${title}, ${option.label}`}
                accessibilityHint={option.description}
                accessibilityState={{ checked, disabled: inactive }}
                onPress={() => onChange(option.value)}
                disabled={inactive}
                style={({ pressed }) => ({
                  flexGrow: 1,
                  flexBasis: type.small.fontSize * fontScale * 7,
                  minWidth: 0,
                  minHeight: 44,
                  justifyContent: "center",
                  borderRadius: 12,
                  borderWidth: checked ? 2 : 1,
                  borderColor: checked ? c.accent : c.line,
                  paddingLeft: checked ? 10 : 11,
                  paddingRight: checked ? 28 : 29,
                  paddingVertical: checked ? 6 : 7,
                  backgroundColor: pressed ? c.pressed : c.surface,
                  opacity: inactive ? 0.5 : 1,
                })}
              >
                <Text style={[type.small, { color: c.text }]}>
                  <SettingsMatch text={option.label} />
                </Text>
                {option.description && (
                  <Text style={[type.meta, { color: c.muted }]}>
                    <SettingsMatch text={option.description} />
                  </Text>
                )}
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
          })}
        </View>
      }
    />
  );
}
