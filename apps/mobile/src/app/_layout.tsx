import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Platform, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { SessionProvider, useSession } from "../state/session";
import { AppearanceProvider } from "../state/appearance";
import { OverviewProvider } from "../state/overview";
import { OverviewBusProvider } from "../state/overview-bus";
import { useBotListSync } from "../state/bot-list";
import { LayoutProvider } from "../state/layout";
import { PreferencesProvider } from "../state/preferences";
import { useColors } from "../ui/theme";
import { useReducedMotion } from "../ui/motion";
import { DevicePreferencesProvider } from "../features/settings/device-preferences";
import { InAppAlerts } from "../features/navigation/InAppAlerts";
import { ConfirmHost } from "../ui/Confirm";
import { ToastHost } from "../ui/Toast";
import { PhoneUpdatesProvider } from "../features/updates/phone";
import { UpdatesProvider } from "../features/updates/state";
import { UpdateCenter } from "../features/updates/UpdateCenter";
import { KeyboardWindow } from "../ui/KeyboardWindow";
import {
  useFonts,
  Inter_400Regular,
  Inter_400Regular_Italic,
  Inter_500Medium,
  Inter_500Medium_Italic,
  Inter_600SemiBold,
  Inter_600SemiBold_Italic,
} from "@expo-google-fonts/inter";

export const unstable_settings = { anchor: "(main)" };

/** Settings covers the complete workspace; its transition never resizes the thread underneath. */
function Navigation() {
  const c = useColors();
  const reduced = useReducedMotion();
  const pathname = usePathname();
  const { session } = useSession();

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <StatusBar style={c.dark ? "light" : "dark"} />
      <Stack
        screenLayout={({ children }) => (
          <LayoutAnimationConfig skipEntering skipExiting>
            {children}
          </LayoutAnimationConfig>
        )}
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }}
      >
        <Stack.Protected guard={Boolean(session)}>
          <Stack.Screen name="(main)" options={{ animation: "none" }} />
          <Stack.Screen
            name="settings"
            options={{
              animation: reduced ? "none" : Platform.OS === "android" ? "slide_from_bottom" : "default",
              // The section stack owns horizontal back gestures until its list is reached.
              gestureEnabled: pathname === "/settings",
            }}
          />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="pair" options={{ animation: reduced ? "none" : "default" }} />
        </Stack.Protected>
      </Stack>
      <InAppAlerts />
      <UpdateCenter />
      <ConfirmHost />
      <ToastHost key={session?.deviceId ?? "unpaired"} />
    </View>
  );
}

/** Keeps the pairing's shared bot list current for the sidebar, alerts and settings. */
function BotListSync() {
  useBotListSync();

  return null;
}

function SessionUI() {
  const { session } = useSession();

  return (
    <OverviewBusProvider>
      <AppearanceProvider key={session?.deviceId ?? "unpaired"}>
        <OverviewProvider>
          <UpdatesProvider key={session?.deviceId ?? "unpaired"}>
            <PhoneUpdatesProvider>
              <LayoutProvider>
                <BotListSync />
                <Navigation />
              </LayoutProvider>
            </PhoneUpdatesProvider>
          </UpdatesProvider>
        </OverviewProvider>
      </AppearanceProvider>
    </OverviewBusProvider>
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
      <KeyboardWindow>
        <PreferencesProvider>
          <DevicePreferencesProvider>
            <SessionProvider>
              <SessionUI />
            </SessionProvider>
          </DevicePreferencesProvider>
        </PreferencesProvider>
      </KeyboardWindow>
    </SafeAreaProvider>
  );
}
