import { Pressable } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/Toast";

/** A tap or long press exposes the same label a screen reader announces. */
export function StatusIcon({ name, label, color }: { name: IconName; label: string; color?: string | undefined }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show status"
      hitSlop={12}
      onPress={() => toast(label)}
      onLongPress={() => toast(label)}
    >
      <Icon name={name} color={color} />
    </Pressable>
  );
}
