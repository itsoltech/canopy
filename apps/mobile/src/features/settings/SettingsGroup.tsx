import { Children, Fragment, isValidElement, useContext, useState, type ReactNode } from "react";
import { StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { contextType } from "@canopy/ui";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { font, styles, useColors, useTypography, weightedFont } from "../../ui/theme";
import { Switch } from "../../ui/Switch";
import { WIDE_OVERLAY } from "../../ui/Overlay";
import { CompactControls, SettingsButtonAlignment } from "../../ui/density";
import { GroupRow, SettingsRow } from "./SettingsRow";
import { SettingsMatch } from "./SettingsSearch";

export { SettingsRow, SettingsRowScope } from "./SettingsRow";

export { SettingOptions } from "./SettingOptions";

export function SettingsActions({ children }: { children: ReactNode }) {
  const alignment = useContext(SettingsButtonAlignment);
  const { width, height } = useWindowDimensions();
  // DialogActions places the primary (last) action first on a phone; keep its reading order in sync.
  const stacked = alignment === "stretch" && width < WIDE_OVERLAY && height >= width;

  return (
    <View
      style={{
        flexDirection: stacked ? "column" : "row",
        flexWrap: stacked ? "nowrap" : "wrap",
        maxWidth: "100%",
        justifyContent: "flex-end",
        alignItems: stacked ? "stretch" : "center",
        gap: 8,
      }}
    >
      {stacked ? Children.toArray(children).reverse() : children}
    </View>
  );
}

type HeaderProps = { title?: string; description?: string; actions?: ReactNode };

export function SettingsGroupHeader({ title, description, actions }: HeaderProps) {
  const c = useColors("settings");
  const type = useTypography();

  if (!title && !description && !actions) return null;

  return (
    <View style={[styles.row, { alignItems: "flex-end", flexWrap: "wrap", justifyContent: "space-between" }]}>
      {(title || description) && (
        <View style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: 160, gap: 2 }}>
          {title && (
            <Text
              accessibilityRole="header"
              style={[type.small, weightedFont(type.small.fontFamily, "semibold"), { color: c.text }]}
            >
              <SettingsMatch text={title} />
            </Text>
          )}
          {description && (
            <Text style={[type.meta, { color: c.muted }]}>
              <SettingsMatch text={description} />
            </Text>
          )}
        </View>
      )}
      {actions && (
        <View style={{ maxWidth: "100%", flexShrink: 1 }}>
          <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
        </View>
      )}
    </View>
  );
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: HeaderProps & { title: string; children: ReactNode }) {
  const c = useColors("settings");

  return (
    <View style={{ padding: 16, gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.rule }}>
      <SettingsGroupHeader title={title} description={description} actions={actions} />
      <GroupRow.Provider value={true}>{children}</GroupRow.Provider>
    </View>
  );
}

// Children can be components which render nothing, such as resolved loading placeholders.
// Measure only their contents so an empty item consumes neither a row inset nor a divider.
function GroupItem({ children }: { children: ReactNode }) {
  const c = useColors("settings");
  const [empty, setEmpty] = useState(false);

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: empty ? 0 : 10 }}>
      {!empty && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -StyleSheet.hairlineWidth,
            height: StyleSheet.hairlineWidth,
            backgroundColor: c.rule,
          }}
        />
      )}
      <View onLayout={(event) => setEmpty(event.nativeEvent.layout.height === 0)} style={{ minWidth: 0, gap: 8 }}>
        {children}
      </View>
    </View>
  );
}

function groupItems(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment)
      return groupItems(child.props.children);

    return child ? <GroupItem>{child}</GroupItem> : null;
  });
}

export function SettingsGroup({
  title,
  description,
  actions,
  children,
  style,
}: HeaderProps & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors("settings");

  return (
    <View style={[{ gap: 8, minWidth: 0 }, style]}>
      {(title || description || actions) && (
        <View style={{ paddingHorizontal: 4 }}>
          <SettingsGroupHeader title={title} description={description} actions={actions} />
        </View>
      )}
      <View
        style={{
          borderWidth: 1,
          borderColor: c.ring,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: c.surface,
        }}
      >
        <GroupRow.Provider value={true}>{groupItems(children)}</GroupRow.Provider>
      </View>
    </View>
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
  // Mount the native picker on demand and retain it through its dismissal animation.
  const [open, setOpen] = useState<boolean>();

  return (
    <SettingsRow
      title={title}
      description={description}
      accessory={accessory}
      controlWidth={192}
      control={
        <>
          <SelectField
            hideLabel
            expanded={!!open}
            label={title}
            value={options.find((o) => o.value === value)?.label ?? String(value)}
            onPress={() => setOpen(true)}
            disabled={disabled}
          />
          {open !== undefined && (
            <PickerSheet
              title={title}
              search={search}
              visible={open}
              onClose={() => setOpen(false)}
              onDismiss={() => setOpen((visible) => visible || undefined)}
              value={value}
              sections={[{ options }]}
              onSelect={onChange}
            />
          )}
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
      controlWidth={44}
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
