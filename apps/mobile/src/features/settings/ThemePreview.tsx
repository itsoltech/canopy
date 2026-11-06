import { View } from "react-native";
import { themeVariables, type ThemeMode, type ThemeName } from "@canopy/ui/themes";

/** The same 48 dp miniature used by the web's ThemePreview. */
export function ThemePreview({ theme, mode }: { theme: ThemeName; mode: ThemeMode }) {
  const c = themeVariables(theme, mode);

  return (
    <View
      accessible={false}
      style={{ height: 48, flexDirection: "row", borderRadius: 6, overflow: "hidden", backgroundColor: c.canvas }}
    >
      <View
        style={{
          width: "25%",
          padding: 6,
          gap: 4,
          backgroundColor: c.panel,
          borderRightWidth: 1,
          borderColor: c.border,
        }}
      >
        <View style={{ height: 6, width: "75%", borderRadius: 2, backgroundColor: c.accent }} />
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.border }} />
        <View style={{ height: 4, width: "66%", borderRadius: 2, backgroundColor: c.border }} />
      </View>
      <View style={{ flex: 1, padding: 6, justifyContent: "space-between", gap: 4 }}>
        <View style={{ gap: 2 }}>
          <View
            style={{ height: 6, width: "50%", alignSelf: "flex-end", borderRadius: 2, backgroundColor: c.border }}
          />
          <View style={{ height: 4, width: "80%", borderRadius: 2, backgroundColor: c.muted }} />
          <View style={{ height: 4, width: "60%", borderRadius: 2, backgroundColor: c.border }} />
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 4,
            paddingVertical: 2,
            borderWidth: 1,
            borderRadius: 2,
            borderColor: c.border,
            backgroundColor: c.surface,
          }}
        >
          <View style={{ height: 4, width: "33%", borderRadius: 2, backgroundColor: c.border }} />
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: c.accent }} />
        </View>
      </View>
    </View>
  );
}
