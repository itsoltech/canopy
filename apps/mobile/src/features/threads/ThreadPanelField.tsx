import type { ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

/** Shared icon gutter and label/value rhythm for placement fields. */
export function ThreadPanelField({
  icon,
  label,
  value,
  aside,
  children,
  style,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <View style={[{ minHeight: 48, flexDirection: "row", gap: 8, paddingVertical: 8 }, style]}>
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[styles.chromeMeta, { color: c.muted }]}>{label}</Text>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>{value}</View>
          {aside}
        </View>
        {children}
      </View>
    </View>
  );
}
