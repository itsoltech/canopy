import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Question } from "@canopy/domain/questions";
import { Icon } from "../../../ui/Icon";
import { font, styles, useColors } from "../../../ui/theme";

export function QuestionOption({
  option,
  multiple,
  checked,
  recommended,
  disabled,
  onSelect,
  style,
}: {
  option: Question["options"][number];
  multiple: boolean;
  checked: boolean;
  recommended: boolean;
  disabled: boolean;
  onSelect: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole={multiple ? "checkbox" : "radio"}
      accessibilityLabel={[option.label, recommended ? "Recommended" : ""].filter(Boolean).join(". ")}
      accessibilityHint={option.description}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: 48,
          padding: 8,
          alignItems: "flex-start",
          borderRadius: 8,
          backgroundColor: checked ? c.softAccent : pressed ? c.pressed : undefined,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      <View style={{ height: styles.overlay.lineHeight, justifyContent: "center" }}>
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: multiple ? 4 : 9,
            borderWidth: 1,
            borderColor: checked ? c.brand : c.muted,
            backgroundColor: checked ? c.brand : c.control,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {checked && <Icon name="check" size={14} color={c.onControl} />}
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[styles.overlay, { color: c.text, fontFamily: font.medium }]}>{option.label}</Text>
        {recommended && <Text style={[styles.overlayMeta, { color: c.accent }]}>Recommended</Text>}
        {option.description ? <Text style={[styles.overlayMeta, { color: c.muted }]}>{option.description}</Text> : null}
      </View>
    </Pressable>
  );
}
