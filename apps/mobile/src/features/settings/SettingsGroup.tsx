import { Children, createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { contextType } from "@canopy/ui";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { Icon } from "../../ui/Icon";
import { SheetContent } from "../../ui/components";
import { font, styles, useColors, useTypography } from "../../ui/theme";

const GroupRow = createContext(false);
const WideGroup = createContext(false);

export const SettingsRowScope = createContext<{
  accessory?: ReactNode;
  caption?: string;
  reset?: (title: string) => ReactNode;
}>({});

export function SettingsActions({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
      {children}
    </View>
  );
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();

  return (
    <View style={{ padding: 16, gap: 12, borderTopWidth: 0.5, borderColor: c.line }}>
      <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between" }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text accessibilityRole="header" style={[styles.chrome, { fontFamily: font.semibold, color: c.text }]}>
            {title}
          </Text>
          {description && <Text style={[styles.workMeta, { color: c.muted }]}>{description}</Text>}
        </View>
        {actions}
      </View>
      <GroupRow.Provider value={true}>{children}</GroupRow.Provider>
    </View>
  );
}

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
  const [wide, setWide] = useState(false);

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
        onLayout={(event) => setWide(event.nativeEvent.layout.width >= 560)}
        style={{
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: c.surface,
        }}
      >
        <WideGroup.Provider value={wide}>
          <GroupRow.Provider value={true}>
            {Children.map(children, (child, index) =>
              child ? (
                <View style={{ padding: 12, gap: 12, borderTopWidth: index ? 0.5 : 0, borderColor: c.line }}>
                  {child}
                </View>
              ) : null,
            )}
          </GroupRow.Provider>
        </WideGroup.Provider>
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
  accessory,
  inlineControl,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  control?: ReactNode;
  onPress?: () => void;
  soon?: boolean;
  style?: StyleProp<ViewStyle>;
  accessory?: ReactNode;
  inlineControl?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const grouped = useContext(GroupRow);
  const inSheet = useContext(SheetContent);
  const scope = useContext(SettingsRowScope);
  const wide = useContext(WideGroup);
  const beside = inlineControl || wide;

  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: beside ? "center" : "flex-start", gap: 12 }}>
        <View style={{ minWidth: 0, flex: 1, gap: 3 }}>
          <Text style={[type.chrome, { color: c.text }]}>
            {title}
            {soon ? " · Soon" : ""}
          </Text>
          {description && <Text style={[type.meta, { color: c.muted }]}>{description}</Text>}
        </View>
        {beside && control && (
          <View style={inlineControl ? undefined : { width: 240, maxWidth: "50%" }}>{control}</View>
        )}
        {accessory ?? scope.accessory ?? scope.reset?.(title)}
      </View>
      {!beside && control && <View style={{ minWidth: 0, maxWidth: "100%", opacity: soon ? 0.5 : 1 }}>{control}</View>}
      {children}
      {scope.caption && <Text style={[type.meta, { color: c.muted }]}>{scope.caption}</Text>}
      {onPress && <Icon name="chevron-right" />}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [{ padding: grouped || inSheet ? 0 : 12, gap: 12 }, style];

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
  accessory,
  search,
}: {
  title: string;
  description?: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  accessory?: ReactNode;
  search?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <SettingsRow
      title={title}
      description={description}
      accessory={accessory}
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
            search={search}
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
  accessory,
}: {
  title: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  accessory?: ReactNode;
}) {
  const c = useColors();

  return (
    <SettingsRow
      title={title}
      description={description}
      inlineControl
      accessory={accessory}
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
