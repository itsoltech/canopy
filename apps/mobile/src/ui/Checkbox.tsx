import { Pressable, Text, View } from "react-native";
import { Icon } from "./Icon";
import { font, styles, useColors, useTypography } from "./theme";

/**
 * Web: Checkbox. A 20 dp box (radius 4): a zinc-300 border on white, brand when checked; label and description sit
 * 12 dp to the right, and the whole row of at least 48 dp is the target.
 */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[styles.row, { minHeight: 48, gap: 12, alignItems: "flex-start", paddingVertical: 4 }]}
    >
      <View style={{ height: type.body.lineHeight, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: checked ? c.brand : c.dark ? "#ffffff26" : "#d4d4d8",
            backgroundColor: checked ? c.brand : c.control,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {checked ? <Icon name="check" size={16} color={c.onControl} /> : null}
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.body, { fontFamily: font.medium, color: c.text }]}>{label}</Text>
        {description ? <Text style={[type.body, { color: c.muted }]}>{description}</Text> : null}
      </View>
    </Pressable>
  );
}
