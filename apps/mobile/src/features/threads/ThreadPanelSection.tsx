import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useColors, useTypography } from "../../ui/theme";

/** Shared rhythm for thread details: quiet headers, compact rows and subtle section dividers. */
export function ThreadPanelSection({
  title,
  count,
  action,
  children,
  style,
}: {
  title?: string;
  count?: number;
  action?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      style={[
        {
          minWidth: 0,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: c.rule,
        },
        style,
      ]}
    >
      {(title || action) && (
        <View style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={[type.meta, { flex: 1, color: c.muted }]}>
            {title}
            {count !== undefined ? ` · ${count}` : ""}
          </Text>
          {action}
        </View>
      )}
      {children}
    </View>
  );
}
