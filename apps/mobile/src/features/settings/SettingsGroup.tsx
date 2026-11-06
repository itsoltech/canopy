import { Children, createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { contextType } from "@canopy/ui";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { Icon } from "../../ui/Icon";
import { SheetContent } from "../../ui/components";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { Skeleton, useSkeleton } from "../../ui/Skeleton";
import { Switch } from "../../ui/Switch";
import { CompactControls } from "../../ui/density";

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
          {description && (
            <Skeleton>
              <Text style={[styles.workMeta, { color: c.muted }]}>{description}</Text>
            </Skeleton>
          )}
        </View>
        <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
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
              <Skeleton>
                <Text accessibilityRole="header" style={[styles.label, { fontFamily: font.semibold, color: c.text }]}>
                  {title}
                </Text>
              </Skeleton>
            )}
            {description && (
              <Skeleton>
                <Text style={[styles.workMeta, { color: c.muted }]}>{description}</Text>
              </Skeleton>
            )}
          </View>
          <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
        </View>
      )}
      <View
        onLayout={(event) => setWide(event.nativeEvent.layout.width >= 560)}
        style={{
          borderWidth: 1,
          borderColor: c.ring,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: c.surface,
        }}
      >
        <WideGroup.Provider value={wide}>
          <GroupRow.Provider value={true}>
            {Children.map(children, (child, index) =>
              child ? (
                <View
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    gap: 8,
                    borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                    borderColor: c.ring,
                  }}
                >
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
  const loading = useSkeleton();
  // Reset sits on the control's inner side, as on the web: its space stays reserved, so nothing moves.
  const reset = accessory ?? scope.accessory ?? scope.reset?.(title);

  const body = (
    <>
      <View style={{ flexDirection: "row", alignItems: beside ? "center" : "flex-start", gap: 12 }}>
        <View style={{ minWidth: 0, flex: 1, gap: 3 }}>
          <Skeleton>
            <Text style={[type.chrome, { fontFamily: font.medium, color: c.text }]}>
              {title}
              {soon ? " · Soon" : ""}
            </Text>
          </Skeleton>
          {description && (
            <Skeleton>
              <Text style={[type.meta, { color: c.muted }]}>{description}</Text>
            </Skeleton>
          )}
        </View>
        {beside && control && reset}
        {beside && control && (
          <View style={inlineControl ? undefined : { width: 240, maxWidth: "50%" }}>
            <Skeleton>{control}</Skeleton>
          </View>
        )}
        {!control && reset}
      </View>
      {!beside && control && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, opacity: soon ? 0.5 : 1 }}>
          {reset}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Skeleton>{control}</Skeleton>
          </View>
        </View>
      )}
      {children}
      {scope.caption && (
        <Skeleton>
          <Text style={[type.meta, { color: c.muted }]}>{scope.caption}</Text>
        </Skeleton>
      )}
      {onPress && <Icon name="chevron-right" />}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [{ padding: grouped || inSheet ? 0 : 12, gap: 12 }, style];

  return onPress ? (
    <Pressable
      accessibilityRole="button"
      disabled={loading}
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
  return (
    <SettingsRow
      title={title}
      description={description}
      inlineControl
      accessory={accessory}
      control={
        <View style={{ minHeight: 44, justifyContent: "center" }}>
          <Switch label={title} value={value} onChange={onChange} disabled={disabled} />
        </View>
      }
    />
  );
}

export const settingsType = { ...contextType.chrome, fontFamily: font.regular };
