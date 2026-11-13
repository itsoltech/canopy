import { Stack } from "expo-router";
import { Platform } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useLayout } from "../../state/layout";
import { useColors } from "../../ui/theme";
import { useReducedMotion } from "../../ui/motion";
import { ScreenActivity } from "../../ui/ScreenActivity";

export const unstable_settings = { initialRouteName: "index" };

export default function SettingsStack() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();

  return (
    <Stack
      screenLayout={({ children }) => (
        <LayoutAnimationConfig skipEntering skipExiting>
          <ScreenActivity>{children}</ScreenActivity>
        </LayoutAnimationConfig>
      )}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.background },
        animation: reduced || wide ? "none" : Platform.OS === "android" ? "slide_from_right" : "default",
      }}
    />
  );
}
