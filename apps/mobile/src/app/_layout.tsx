import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../state/session";
import { useColors } from "../ui/theme";
import { AppearanceProvider } from "../state/appearance";
import { OverviewProvider } from "../state/overview";
import { LayoutProvider, useLayout } from "../state/layout";
import { PreferencesProvider } from "../state/preferences";
import { View } from "react-native";
import { AppSidebar } from "../features/navigation/AppSidebar";
import { useReducedMotion } from "../ui/motion";
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
  const { sidebarOpen, sidebarWidth } = useLayout();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const showSidebar = session && sidebarOpen && pathname !== "/settings";

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.background }}>
      <StatusBar style={c.dark ? "light" : "dark"} />
      {showSidebar && (
        <PaneInsets.Provider value={{ left: insets.left, right: 0 }}>
          <View style={{ width: sidebarWidth, borderRightWidth: 1, borderRightColor: c.line }}>
            <AppSidebar />
          </View>
        </PaneInsets.Provider>
      )}
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

/** Beside the sidebar screens swap in place: a slide would carry the old screen over the list. */
function Screens() {
  const c = useColors();
  const { wide } = useLayout();
  const reduced = useReducedMotion();

  return (
    <Stack
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
