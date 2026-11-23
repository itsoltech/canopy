import { router, Stack } from "expo-router";
import { isString } from "@canopy/domain/json";
import { Platform } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useLayout } from "../../state/layout";
import { useColors } from "../../ui/theme";
import { useReducedMotion } from "../../ui/motion";
import { SettingsLayout } from "../../features/settings/SettingsLayout";
import { settingsScope } from "../../features/settings/navigation";
import { ScreenActivity } from "../../ui/ScreenActivity";

export const unstable_settings = { initialRouteName: "index" };

export default function SettingsStack() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();

  return (
    <Stack
      layout={({ children, state, navigation }) => {
        const params = state.routes[state.index]?.params;
        const selected = params && "section" in params && isString(params.section) ? params.section : undefined;

        return (
          <SettingsLayout
            selected={selected}
            scoped={settingsScope(params).length > 0}
            close={() => {
              const parent = navigation.getParent();

              if (parent?.canGoBack()) parent.goBack();
              else router.replace("/");
            }}
          >
            {children}
          </SettingsLayout>
        );
      }}
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
