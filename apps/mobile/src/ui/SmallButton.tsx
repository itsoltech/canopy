import { ActivityIndicator, Pressable, Text } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "./Icon";
import { font, styles, useColors } from "./theme";

/**
 * The `sm` secondary button of rows and cards (docs/ui-scale.md: 32 dp, text 14, icon 16), with an invisible
 * 48 dp touch target. Web: Button size="sm".
 */
export function SmallButton({
  title,
  icon,
  onPress,
  disabled,
  busy,
}: {
  title: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.row,
        {
          gap: 4,
          minHeight: 32,
          alignSelf: "flex-start",
          paddingLeft: icon || busy ? 8 : 10,
          paddingRight: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: c.line,
          backgroundColor: pressed ? c.inset : c.surface,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={c.muted} /> : icon ? <Icon name={icon} color={c.muted} /> : null}
      <Text style={[styles.meta, { fontFamily: font.medium, color: c.text }]}>{title}</Text>
    </Pressable>
  );
}
