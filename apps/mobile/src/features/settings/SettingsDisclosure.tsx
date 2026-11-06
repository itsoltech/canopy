import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Chevron, Expand } from "../../ui/MotionViews";
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
        <Chevron open={open} />
        <Text style={[styles.workMeta, { flex: 1, color: c.muted }]}>{title}</Text>
      </Pressable>
      {/* Accordion (web `expand`): the content grows from its header and shrinks back. */}
      <Expand open={open} style={{ gap: 8 }}>
        {children}
      </Expand>
    </View>
  );
}
