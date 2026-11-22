import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppearance } from "../../state/appearance";
import { useSession } from "../../state/session";
import { useColors } from "../../ui/theme";
import { useLayout } from "../../state/layout";
import { View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useReducedMotion } from "../../ui/motion";
import { PaneInsets } from "../../ui/ScreenFrame";
import { ScreenActivity } from "../../ui/ScreenActivity";
import { SidebarColumn } from "./SidebarColumn";

/** Wide windows keep the thread list beside the stack (collapsible); phones navigate list → thread. */
export default function MainNavigation() {
  const c = useColors();
  const { session } = useSession();
  const { wide, sidebarOpen } = useLayout();
  const insets = useSafeAreaInsets();
  const split = wide && Boolean(session);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.background }}>
      {split && <SidebarColumn open={sidebarOpen} leftInset={insets.left} rightInset={insets.right} />}
      <PaneInsets.Provider value={{ left: split ? 0 : insets.left, right: insets.right }}>
        <View style={{ flex: 1, overflow: "hidden" }}>
          <Screens />
        </View>
      </PaneInsets.Provider>
    </View>
  );
}

/** Beside the sidebar screens swap in place: a slide would carry the old screen over the list. */
function Screens() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();
  const { threadsEnabled, botsEnabled } = useAppearance();

  return (
    <Stack
      // A screen's first render and its removal do not animate its rows and notices; later changes do.
      screenLayout={({ children }) => (
        <LayoutAnimationConfig skipEntering skipExiting>
          <ScreenActivity>{children}</ScreenActivity>
        </LayoutAnimationConfig>
      )}
      screenOptions={{
        animation: reduced || wide ? "none" : "default",
        // Screens defaults to full-screen back swipes on iOS 26, competing with wide message content.
        fullScreenGestureEnabled: false,
        headerShown: false,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Protected guard={threadsEnabled}>
        <Stack.Screen
          name="thread/[id]"
          options={({ route }) =>
            route.params && "preparation" in route.params && route.params.preparation === "1"
              ? { animation: "none" }
              : {}
          }
        />
        <Stack.Screen name="thread-starting/[id]" options={{ animation: "none" }} />
        <Stack.Screen name="new-thread" />
        <Stack.Screen name="pull-request/[id]" />
      </Stack.Protected>
      <Stack.Protected guard={botsEnabled}>
        <Stack.Screen name="bot/[id]" />
        <Stack.Screen name="bot-exchange/[id]" />
      </Stack.Protected>
    </Stack>
  );
}
