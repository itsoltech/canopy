import { useState } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { TextInput } from "./TextInput";
import { Icon } from "./Icon";
import { styles, useColors } from "./theme";

/**
 * Web: SearchField. A ringed 40 dp field with a leading magnifier; the ring turns brand and 2 dp on focus. Text stays
 * 16 on phones (no zoom on focus). A clear button appears inside, at the end, so the text does not move.
 */
export function SearchField({
  label,
  placeholder = label,
  value,
  onChange,
  bare = false,
  style,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Without the ring and fill (the sidebar's search); focus still shows the brand ring. */
  bare?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.row,
        {
          minHeight: 40,
          paddingLeft: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: bare ? "transparent" : c.ring,
          backgroundColor: bare ? "transparent" : c.surface,
        },
        focused && { borderWidth: 2, borderColor: c.brand, paddingLeft: 9 },
        style,
      ]}
    >
      <Icon name="magnifying-glass" color={c.faint} />
      <TextInput
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        style={[styles.body, { flex: 1, minWidth: 0, color: c.text, paddingVertical: 8 }]}
      />
      <View style={{ width: 36, alignItems: "center" }}>
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => onChange("")}
            hitSlop={6}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="x-circle" color={c.faint} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
