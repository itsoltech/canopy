import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function SettingsDisclosure({
  title,
  children,
  initiallyOpen = false,
}: {
  title: string;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const c = useColors();

  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={[styles.row, { minHeight: 44 }]}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron-right" />
        </View>
        <Text style={[styles.workMeta, { flex: 1, color: c.muted }]}>{title}</Text>
      </Pressable>
      {open && children}
    </View>
  );
}
