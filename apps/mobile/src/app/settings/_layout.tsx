import { router, Stack } from "expo-router";
import { isString } from "@canopy/domain/json";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useColors } from "../../ui/theme";
import { SettingsLayout } from "../../features/settings/SettingsLayout";
import { settingsScope } from "../../features/settings/navigation";
import { ScreenActivity } from "../../ui/ScreenActivity";

export default function SettingsStack() {
  const c = useColors();

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
        animation: "none",
      }}
    />
  );
}
