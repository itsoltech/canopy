import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";

/**
 * A short state of the file or tree floating over the bottom of its list, so a notice never pushes rows or
 * lines down; it appears and goes without moving what the reader is looking at.
 */
export function FileNoticePill({ text, tone, children }: { text: string; tone?: "danger"; children?: ReactNode }) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 12, right: 12, bottom: 12, alignItems: "flex-start" }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.ring,
          backgroundColor: c.overlay,
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole={tone === "danger" ? "alert" : undefined}
          style={[type.small, { color: tone === "danger" ? c.danger : c.muted, flexShrink: 1 }]}
        >
          {text}
        </Text>
        {children}
      </View>
    </View>
  );
}
