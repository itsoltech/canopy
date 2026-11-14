import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { useColors } from "../../ui/theme";

/** One placement line: icon, a single-line value and a fixed trailing slot; the whole line is the touch target. */
export function ThreadPanelLine({
  icon,
  value,
  trailing,
  label,
  hint,
  disabled = false,
  busy = false,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  value: ReactNode;
  trailing: Parameters<typeof Icon>[0]["name"];
  label: string;
  hint?: string;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint || undefined}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: 8,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <Icon name={icon} />
      <View style={{ flex: 1, minWidth: 0 }}>{value}</View>
      <View style={{ width: 20, alignItems: "center" }}>
        <Icon name={trailing} />
      </View>
    </Pressable>
  );
}
