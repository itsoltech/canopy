import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { contextType } from "@canopy/ui";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";

export function SettingsGroup({
  title,
  description,
  actions,
  children,
  style,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <View style={[{ gap: 8, minWidth: 0 }, style]}>
      {(title || actions) && (
        <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between", paddingHorizontal: 4 }]}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            {title && (
              <Text accessibilityRole="header" style={[styles.meta, { fontFamily: font.semibold, color: c.text }]}>
                {title}
              </Text>
            )}
            {description && <Text style={[styles.workMeta, { color: c.muted }]}>{description}</Text>}
          </View>
          {actions}
        </View>
      )}
      <View
        style={{
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: c.surface,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function SettingsRow({
  title,
  description,
  children,
  control,
  onPress,
  soon,
  style,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  control?: ReactNode;
  onPress?: () => void;
  soon?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  const body = (
    <>
      <View style={{ minWidth: 0, flexShrink: 1, gap: 3 }}>
        <Text style={[styles.chrome, { fontFamily: font.medium, color: c.text }]}>
          {title}
          {soon ? " · Soon" : ""}
        </Text>
        {description && <Text style={[styles.workMeta, { color: c.muted }]}>{description}</Text>}
      </View>
      {control && <View style={{ minWidth: 0, maxWidth: "100%", opacity: soon ? 0.5 : 1 }}>{control}</View>}
      {children}
      {onPress && <Icon name="chevron-right" />}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [{ padding: 12, gap: 8, borderBottomWidth: 0.5, borderColor: c.line }, style];

  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [rowStyle, { backgroundColor: pressed ? c.inset : "transparent" }]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

export function SettingChoice<T extends string | number>({
  title,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <>
          <SelectField
            hideLabel
            label={title}
            value={options.find((o) => o.value === value)?.label ?? String(value)}
            onPress={() => setOpen(true)}
            disabled={disabled}
          />
          <PickerSheet
            title={title}
            visible={open}
            onClose={() => setOpen(false)}
            value={value}
            sections={[{ options }]}
            onSelect={onChange}
          />
        </>
      }
    />
  );
}

export function SettingToggle({
  title,
  description,
  value,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={title}
          accessibilityState={{ checked: value, disabled }}
          disabled={disabled}
          onPress={() => onChange(!value)}
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
        >
          <View
            style={{
              width: 44,
              height: 24,
              padding: 2,
              borderRadius: 12,
              backgroundColor: value ? c.action : c.inset,
              borderWidth: 1,
              borderColor: c.line,
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: value ? c.onControl : c.surface,
                alignSelf: value ? "flex-end" : "flex-start",
              }}
            />
          </View>
        </Pressable>
      }
    />
  );
}

export const settingsType = { ...contextType.chrome, fontFamily: font.regular };
