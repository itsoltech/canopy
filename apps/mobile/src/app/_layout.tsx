import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../state/session";
import { useColors } from "../ui/theme";
import { AppearanceProvider } from "../state/appearance";
import { OverviewProvider } from "../state/overview";
import { LayoutProvider, useLayout } from "../state/layout";
import { PreferencesProvider } from "../state/preferences";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AppSidebar } from "../features/navigation/AppSidebar";
import { motion, smoothOut, useReducedMotion } from "../ui/motion";
import {
  useFonts,
  Inter_400Regular,
  Inter_400Regular_Italic,
  Inter_500Medium,
  Inter_500Medium_Italic,
  Inter_600SemiBold,
  Inter_600SemiBold_Italic,
} from "@expo-google-fonts/inter";
import { DevicePreferencesProvider } from "../features/settings/device-preferences";
import { InAppAlerts } from "../features/navigation/InAppAlerts";
import { ConfirmHost } from "../ui/Confirm";
import { PaneInsets } from "../ui/ScreenFrame";

/** Wide windows keep the thread list beside the stack (collapsible); phones navigate list → thread. */
function Navigation() {
  const c = useColors();
  const { session } = useSession();
  const { wide, sidebarOpen, sidebarWidth } = useLayout();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const showSidebar = Boolean(session) && sidebarOpen && pathname !== "/settings";
  // Only the toggle animates; a rotation, a fold, sign-in or Settings (which has its own list) switch at once.
  const context = `${wide}:${Boolean(session)}:${pathname === "/settings"}`;

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.background }}>
      <StatusBar style={c.dark ? "light" : "dark"} />
      <PaneInsets.Provider value={{ left: insets.left, right: 0 }}>
        <SidebarColumn key={context} open={showSidebar} width={sidebarWidth + insets.left} />
      </PaneInsets.Provider>
      <PaneInsets.Provider value={{ left: showSidebar ? 0 : insets.left, right: insets.right }}>
        <View style={{ flex: 1, overflow: "hidden" }}>
          <Screens />
          <InAppAlerts />
        </View>
      </PaneInsets.Provider>
      <ConfirmHost />
    </View>
  );
}

/**
 * Panel reveal (web `t-sidebar`): the list slides in from the window's edge and fades, opening on `slow` and closing
 * on `medium`. The column takes its width before the slide in and gives it up after the slide out, so the screen
 * beside it lays out once, never during the motion (a long thread re-wraps all its text, which would stall the
 * frames). Instant with reduced motion.
 */
function SidebarColumn({ open, width }: { open: boolean; width: number }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  // The column has laid out at its width: the slide may start.
  const [placed, setPlaced] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);

  const panel = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateX: (progress.get() - 1) * width }],
  }));

  if (open && !mounted) setMounted(true);

  if (!mounted && placed) setPlaced(false);
  useEffect(() => {
    if (open && !placed) return;
    const duration = reduced ? 0 : open ? motion.slow : motion.medium;
    progress.set(
      withTiming(open ? 1 : 0, { duration, easing: smoothOut }, (finished) => {
        if (finished && !open) scheduleOnRN(setMounted, false);
      }),
    );
  }, [open, placed, reduced, progress]);

  if (!mounted) return null;

  return (
    <View onLayout={() => setPlaced(true)} style={{ width, overflow: "hidden" }}>
      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        style={[{ flex: 1, width, borderRightWidth: 1, borderRightColor: c.line }, panel]}
      >
        <LayoutAnimationConfig skipEntering skipExiting>
          <AppSidebar />
        </LayoutAnimationConfig>
      </Animated.View>
    </View>
  );
}

/** Beside the sidebar screens swap in place: a slide would carry the old screen over the list. */
function Screens() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();

  return (
    <Stack
      // A screen's first render and its removal do not animate its rows and notices; later changes do.
      screenLayout={({ children }) => (
        <LayoutAnimationConfig skipEntering skipExiting>
          {children}
        </LayoutAnimationConfig>
      )}
      screenOptions={{
        animation: reduced ? "none" : wide ? "fade" : "default",
        headerShown: false,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Canopy" }} />
      <Stack.Screen name="pair" options={{ title: "Connect to Canopy", headerBackVisible: false }} />
      <Stack.Screen name="thread/[id]" options={{ title: "Thread", headerBackTitle: "Threads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
    </Stack>
  );
}

function SessionUI() {
  const { session } = useSession();

  return (
    <AppearanceProvider key={session?.deviceId ?? "unpaired"}>
      <OverviewProvider>
        <LayoutProvider>
          <Navigation />
        </LayoutProvider>
      </OverviewProvider>
    </AppearanceProvider>
  );
}

export default function Layout() {
  const [loaded, error] = useFonts({
    Inter_400Regular,
    Inter_400Regular_Italic,
    Inter_500Medium,
    Inter_500Medium_Italic,
    Inter_600SemiBold,
    Inter_600SemiBold_Italic,
  });

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <PreferencesProvider>
        <DevicePreferencesProvider>
          <SessionProvider>
            <SessionUI />
          </SessionProvider>
        </DevicePreferencesProvider>
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}
