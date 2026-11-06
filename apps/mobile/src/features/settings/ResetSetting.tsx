import { View } from "react-native";
import { IconButton } from "../../ui/components";

export function ResetSetting({
  label,
  changed,
  disabled,
  onReset,
}: {
  label: string;
  changed: boolean;
  disabled?: boolean;
  onReset: () => void;
}) {
  return (
    <View
      style={{ opacity: changed ? 1 : 0 }}
      accessibilityElementsHidden={!changed}
      importantForAccessibility={changed ? "auto" : "no-hide-descendants"}
    >
      <IconButton icon="arrow-path" size="sm" label={label} disabled={!changed || disabled} onPress={onReset} />
    </View>
  );
}
