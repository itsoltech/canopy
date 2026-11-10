import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/Toast";
import { useColors } from "../../ui/theme";

export function IconAction({
  icon,
  label,
  selected,
  onPress,
  style,
}: {
  icon: IconName;
  label: string;
  selected?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      onLongPress={() => toast(label)}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: 32,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          backgroundColor: pressed || selected ? c.pressed : "transparent",
        },
        style,
      ]}
    >
      <Icon name={icon} color={selected ? c.text : c.muted} />
    </Pressable>
  );
}
